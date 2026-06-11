/**
 * GRUPO NEW ENERGY - Backend para formulario de tramitación (gnew.html)
 *
 * SETUP:
 * 1. Ve a https://script.google.com y abre el proyecto del formulario GNEW
 * 2. Pega este código en Code.gs
 * 3. FOLDER_ID = ID de la carpeta de Drive donde se guardan los contratos
 * 4. FORM_TOKEN debe coincidir con el de gnew.html
 * 5. "Implementar" > "Administrar implementaciones" > editar > Nueva versión
 * 6. Ejecutar como: "Yo" (tu cuenta)
 * 7. Acceso: "Cualquier persona" — imprescindible: el navegador necesita poder
 *    leer la respuesta JSON para confirmar el envío antes de dar el OK al usuario
 *
 * ORDEN DE DESPLIEGUE cuando cambian front y back a la vez: primero Vercel
 * (gnew.html), después esta nueva versión. El backend antiguo ignora los campos
 * token/ref_id, pero este nuevo RECHAZA envíos sin token: si se despliega antes
 * que el front, los envíos del HTML viejo fallarían.
 */

const EMAIL_TO = 'escaneos@gruponew.energy';
// Carpeta "Contratos Grupo New Energy" en la cuenta de MEGA (re-montaje 2026-06,
// el proyecto antiguo quedó en una cuenta inaccesible). El Sheet de registro se
// auto-crea aquí dentro.
const FOLDER_ID = '1bTZhjmR9kPggL40ABS2JoHe3URuLlPim';
const FORM_TOKEN = 'GNE-2026-w7k4q9x2'; // debe coincidir con gnew.html
const ALLOWED_EXTENSIONS = ['pdf', 'jpg', 'jpeg', 'png', 'doc', 'docx'];
const MAX_FILES = 15; // debe coincidir con MAX_FILES de gnew.html
// gnew.html limita los adjuntos a 30MB reales (~40M caracteres en base64).
// Margen hasta 45M antes de rechazar por tamaño.
const MAX_TOTAL_BASE64_CHARS = 45 * 1024 * 1024;
const MAX_FIRMA_CHARS = 2 * 1024 * 1024; // la firma es un PNG pequeño; más es abuso

function doPost(e) {
  let data;
  try {
    data = JSON.parse(e.postData.contents);
  } catch (parseErr) {
    return jsonResponse({ success: false, error: 'Petición no válida' });
  }
  if (!data || typeof data !== 'object') {
    return jsonResponse({ success: false, error: 'Petición no válida' });
  }

  if (data.token !== FORM_TOKEN) {
    return jsonResponse({ success: false, error: 'No autorizado' });
  }

  // El front genera el refId y lo reutiliza en sus reintentos; si no llega o no
  // cuadra el formato, se genera aquí uno nuevo
  const refId = (typeof data.ref_id === 'string' && /^GNE-\d{8}-[A-Z0-9]{4,10}$/.test(data.ref_id))
    ? data.ref_id
    : generateRefId();

  // Honeypot relleno = bot (o, raro, autofill de un navegador): éxito falso para
  // no dar pistas, pero CON rastro en el Sheet por si fuera un falso positivo
  if (data.hp) {
    logToSheet(refId, data, 0, false, false, '', 'HONEYPOT: campo oculto relleno con "' + cleanLine(String(data.hp)).slice(0, 50) + '"');
    return jsonResponse({ success: true, refId: refId });
  }

  // Límites server-side de la documentación, ANTES del lock: los rechazos
  // baratos y deterministas no deben serializarse ni retener el lock
  const archivos = Array.isArray(data.archivos) ? data.archivos : [];
  if (archivos.length > MAX_FILES) {
    return jsonResponse({ success: false, error: 'Demasiados archivos (máx. ' + MAX_FILES + ')', refId: refId });
  }
  let totalChars = 0;
  for (let i = 0; i < archivos.length; i++) {
    const a = archivos[i] || {};
    const name = String(a.name || '');
    const ext = name.split('.').pop().toLowerCase();
    if (ALLOWED_EXTENSIONS.indexOf(ext) === -1) {
      return jsonResponse({ success: false, error: 'Tipo de archivo no permitido: ' + name, refId: refId });
    }
    totalChars += String(a.data || '').length;
  }
  if (totalChars > MAX_TOTAL_BASE64_CHARS) {
    return jsonResponse({ success: false, error: 'La documentación supera el tamaño máximo permitido', refId: refId });
  }

  // Lock global: serializa ejecuciones concurrentes para que la dedup por refId
  // funcione también cuando un reintento del front llega con la PRIMERA ejecución
  // aún en curso (corte de red móvil después de enviar el body completo). Sin
  // esto, get→proceso largo→put no es atómico y se duplicaría el contrato.
  const cache = CacheService.getScriptCache();
  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(120000); // una ejecución con ~30MB puede superar el minuto
  } catch (lockTimeout) {
    // waitLock LANZA al expirar; sin este catch Apps Script devolvería una página
    // HTML que el front no puede parsear como JSON
    return jsonResponse({ success: false, error: 'Servidor ocupado, vuelve a intentarlo en unos segundos', refId: refId });
  }

  try {
    // Idempotencia: un refId ya tramitado con éxito no se procesa dos veces
    if (cache.get('ref:' + refId)) {
      return jsonResponse({ success: true, refId: refId, duplicated: true });
    }

    let folderUrl = '';
    let emailSent = false;
    let driveOk = false;
    let errorMsg = '';

    try {
      // 1. GOOGLE DRIVE - Guardar archivos
      let fileLinks = [];
      let folder = null;
      try {
        const parentFolder = DriveApp.getFolderById(FOLDER_ID);
        const timestamp = Utilities.formatDate(new Date(), 'Europe/Madrid', 'yyyy-MM-dd HH:mm');
        const folderName = refId + ' - ' + cleanLine(data.titular || 'Sin titular').slice(0, 80) + ' - ' + cleanLine(data.compania || '').slice(0, 40) + ' - ' + timestamp;
        folder = parentFolder.createFolder(folderName);
        folderUrl = folder.getUrl();

        archivos.forEach(function(archivo) {
          const a = archivo || {};
          const safeName = sanitizeFileName(a.name);
          const blob = Utilities.newBlob(
            Utilities.base64Decode(String(a.data || '')),
            String(a.type || 'application/octet-stream'),
            safeName
          );
          const file = folder.createFile(blob);
          // Sin setSharing: la documentación lleva DNI/IBAN/facturas y NO debe
          // quedar accesible a "cualquiera con el enlace" (RGPD). Quien gestiona
          // el buzón accede a la carpeta con su propia cuenta.
          fileLinks.push({
            name: safeName,
            size: cleanLine(String(a.size || '')).slice(0, 20),
            url: file.getUrl()
          });
        });

        // La firma es opcional y secundaria: si viene malformada o desmesurada se
        // ignora, nunca debe invalidar un contrato cuyos documentos ya se subieron
        const firma = String(data.firma || '');
        if (firma && firma.indexOf(',') > -1 && firma.length <= MAX_FIRMA_CHARS) {
          try {
            const sigBlob = Utilities.newBlob(
              Utilities.base64Decode(firma.split(',')[1]),
              'image/png',
              'firma.png'
            );
            const sigFile = folder.createFile(sigBlob);
            fileLinks.push({ name: 'firma.png', size: '—', url: sigFile.getUrl() });
          } catch (sigErr) {
            errorMsg += 'Firma ignorada: ' + sigErr.toString() + '; ';
          }
        }

        driveOk = true;
      } catch (driveErr) {
        errorMsg += 'Drive: ' + driveErr.toString() + '; ';
        // Carpeta a medias: a la papelera, para que el reintento del mismo refId
        // no deje carpetas parciales huérfanas junto a la definitiva
        try {
          if (folder) folder.setTrashed(true);
        } catch (trashErr) {}
        folderUrl = '';
        fileLinks = [];
      }

      // 2. EMAIL - Enviar notificación (intenta 2 veces)
      const mailOptions = {
        htmlBody: '',
        name: 'Grupo New Energy - Tramitaciones'
      };
      // replyTo malformado tumbaría sendEmail: solo si parece un email
      const replyTo = cleanLine(data.email_comercial || '').trim();
      if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(replyTo)) {
        mailOptions.replyTo = replyTo;
      }
      const subject = ('Nuevo Contrato - ' + cleanLine(data.compania || '').slice(0, 40)
        + ' - ' + cleanLine(data.quien_eres || '').slice(0, 60)
        + ' - ' + cleanLine(data.cups || '').slice(0, 25)
        + ' - ' + refId).slice(0, 200);

      for (let attempt = 1; attempt <= 2; attempt++) {
        try {
          mailOptions.htmlBody = buildEmailHtml(data, fileLinks, folderUrl, refId);
          GmailApp.sendEmail(EMAIL_TO, subject, '', mailOptions);
          emailSent = true;
          break;
        } catch (emailErr) {
          errorMsg += 'Email intento ' + attempt + ': ' + emailErr.toString() + '; ';
          if (attempt < 2) Utilities.sleep(2000);
        }
      }

      // 3. REGISTRO en Google Sheet — tercera pata de la "triple seguridad":
      //    aunque fallen Drive y/o el email, queda constancia del intento
      logToSheet(refId, data, archivos.length, driveOk, emailSent, folderUrl, errorMsg);

      // Si Drive funcionó, consideramos éxito (los datos están guardados)
      if (driveOk) {
        // Marcar refId como tramitado SOLO tras éxito: un fallo debe poder reintentarse
        cache.put('ref:' + refId, '1', 21600); // 6h, máximo de CacheService
        return jsonResponse({
          success: true,
          refId: refId,
          emailSent: emailSent,
          driveOk: true
        });
      } else {
        throw new Error(errorMsg || 'No se pudieron guardar los archivos');
      }

    } catch (error) {
      // Último recurso: email de error con TODOS los datos de texto (sin base64),
      // para que el contrato se pueda tramitar a mano aunque Drive haya fallado
      try {
        GmailApp.sendEmail(EMAIL_TO,
          'ERROR en formulario GNEW - ' + refId,
          'Error: ' + error.toString() +
          '\n\nDatos del envío (sin adjuntos):\n' + JSON.stringify(textOnlyData(data), null, 2).slice(0, 50000) +
          '\n\nArchivos que venían adjuntos: ' + (archivos.length > 0 ? archivos.map(function(a) { return sanitizeFileName((a || {}).name); }).join(', ') : 'ninguno')
        );
      } catch (lastErr) {}

      // Al cliente, mensaje genérico: el detalle (stacktrace, ids internos) ya
      // viaja en el email de error y no debe exponerse en un endpoint público
      return jsonResponse({ success: false, error: 'No se pudo guardar la documentación. Inténtalo de nuevo o envíala por email a ' + EMAIL_TO, refId: refId });
    }
  } finally {
    lock.releaseLock();
  }
}

function jsonResponse(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function generateRefId() {
  const now = new Date();
  const date = Utilities.formatDate(now, 'Europe/Madrid', 'yyyyMMdd');
  const rand = Math.random().toString(36).substring(2, 8).toUpperCase();
  return 'GNE-' + date + '-' + rand;
}

// Los datos vienen de un endpoint público: todo lo que se pinta en el email
// pasa por aquí para que nadie pueda inyectar HTML/enlaces en el correo
function escapeHtml(v) {
  return String(v == null ? '' : v)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function cleanLine(v) {
  return String(v == null ? '' : v).replace(/[\r\n]+/g, ' ');
}

function sanitizeFileName(name) {
  return String(name || 'documento').replace(/[\\/:*?"<>|]/g, '_').slice(0, 120);
}

function maskIBAN(v) {
  const c = String(v || '').replace(/\s/g, '');
  return c.length > 8 ? c.slice(0, 4) + '····' + c.slice(-4) : c;
}

// Sheets interpreta como fórmula los valores que empiezan por = + - @ (incluido
// un móvil pegado como "+34..."): prefijar apóstrofo los fuerza a texto literal
function sheetSafe(v) {
  const s = cleanLine(v).slice(0, 500);
  return /^[=+\-@]/.test(s) ? "'" + s : s;
}

function textOnlyData(data) {
  const copy = {};
  for (const k in data) {
    if (k === 'archivos' || k === 'firma' || k === 'token' || k === 'hp') continue;
    copy[k] = data[k];
  }
  return copy;
}

// Registro de cada envío en un Sheet dentro de la carpeta de contratos.
// Se crea solo la primera vez y su ID queda en ScriptProperties (LOG_SHEET_ID).
function logToSheet(refId, data, numArchivos, driveOk, emailSent, folderUrl, errorMsg) {
  try {
    const props = PropertiesService.getScriptProperties();
    let ss = null;
    const ssId = props.getProperty('LOG_SHEET_ID');
    if (ssId) {
      try { ss = SpreadsheetApp.openById(ssId); } catch (openErr) { ss = null; }
    }
    if (!ss) {
      ss = SpreadsheetApp.create('Registro Tramitaciones GNEW');
      DriveApp.getFileById(ss.getId()).moveTo(DriveApp.getFolderById(FOLDER_ID));
      ss.getSheets()[0].appendRow([
        'Fecha', 'Ref', 'Comercial', 'Email comercial', 'Compañía', 'CUPS', 'Titular',
        'CIF/NIF', 'Móvil', 'Email cliente', 'IBAN (enmascarado)', 'Nº archivos',
        'Drive OK', 'Email OK', 'Carpeta', 'Errores'
      ]);
      props.setProperty('LOG_SHEET_ID', ss.getId());
    }
    ss.getSheets()[0].appendRow([
      Utilities.formatDate(new Date(), 'Europe/Madrid', 'dd/MM/yyyy HH:mm:ss'),
      refId,
      sheetSafe(data.quien_eres),
      sheetSafe(data.email_comercial),
      sheetSafe(data.compania),
      sheetSafe(data.cups),
      sheetSafe(data.titular),
      sheetSafe(data.cif_nif),
      sheetSafe(data.movil),
      sheetSafe(data.email_cliente),
      sheetSafe(maskIBAN(data.cuenta_bancaria)),
      numArchivos,
      driveOk ? 'SÍ' : 'NO',
      emailSent ? 'SÍ' : 'NO',
      folderUrl,
      sheetSafe(errorMsg)
    ]);
  } catch (logErr) {
    // El registro nunca debe tumbar la tramitación
  }
}

function buildEmailHtml(data, fileLinks, folderUrl, refId) {
  const fields = [
    ['Referencia', refId],
    ['Comercial', data.quien_eres],
    ['Email Comercial', data.email_comercial],
    ['Compañía', data.compania],
    ['CUPS', data.cups],
    ['Oferta', data.oferta],
    ['Tarifa', data.tarifa],
    ['Potencias', formatPotencias(data)],
    ['Titular / Razón Social', data.titular],
    ['CIF / NIF', data.cif_nif],
    ['Nombre Firmante', data.nombre_firmante],
    ['DNI Firmante', data.dni_firmante],
    ['Dir. Suministro', data.dir_suministro],
    ['Código Postal', data.codigo_postal],
    ['Población', data.poblacion],
    ['Provincia', data.provincia],
    ['Móvil', data.movil],
    ['Email Cliente', data.email_cliente],
    ['Cuenta Bancaria', data.cuenta_bancaria],
    ['Cambio Titular', data.cambio_titular],
    ['Nuevo Titular', data.nuevo_titular],
    ['Observaciones', data.observaciones]
  ];

  let rows = '';
  fields.forEach(function(f) {
    if (f[1]) {
      rows += '<tr>' +
        '<td style="padding:10px 14px;font-weight:600;color:#094D38;background:#f0faf6;border:1px solid #e2e8f0;width:200px;font-size:13px">' + f[0] + '</td>' +
        '<td style="padding:10px 14px;border:1px solid #e2e8f0;font-size:13px">' + escapeHtml(f[1]) + '</td>' +
      '</tr>';
    }
  });

  let filesHtml = '';
  if (fileLinks.length > 0) {
    filesHtml = '<h3 style="color:#094D38;margin:24px 0 12px;font-size:15px">Documentación adjunta</h3><ul style="list-style:none;padding:0">';
    fileLinks.forEach(function(f) {
      filesHtml += '<li style="margin:8px 0;padding:10px 14px;background:#f8fffe;border:1px solid #e2e8f0;border-radius:8px;font-size:13px">' +
        '<a href="' + escapeHtml(f.url) + '" style="color:#0B6E4F;font-weight:600;text-decoration:none">' + escapeHtml(f.name) + '</a>' +
        '<span style="color:#6B7280;margin-left:8px">' + escapeHtml(f.size) + '</span>' +
      '</li>';
    });
    filesHtml += '</ul>';
    filesHtml += '<p style="margin-top:12px"><a href="' + escapeHtml(folderUrl) + '" style="color:#0B6E4F;font-weight:600">Abrir carpeta en Google Drive</a></p>';
  }

  return '<div style="font-family:Arial,sans-serif;max-width:650px;margin:0 auto">' +
    '<div style="background:#094D38;color:#fff;padding:20px 24px;border-radius:10px 10px 0 0">' +
      '<h2 style="margin:0;font-size:18px">Nuevo Contrato para Tramitar</h2>' +
      '<p style="margin:6px 0 0;opacity:.8;font-size:13px">' + Utilities.formatDate(new Date(), 'Europe/Madrid', "dd/MM/yyyy 'a las' HH:mm") + ' — Ref: ' + refId + '</p>' +
    '</div>' +
    '<div style="background:#fff;padding:24px;border:1px solid #e2e8f0;border-top:none;border-radius:0 0 10px 10px">' +
      '<table style="width:100%;border-collapse:collapse">' + rows + '</table>' +
      filesHtml +
    '</div>' +
  '</div>';
}

function formatPotencias(data) {
  const vals = [];
  ['p1','p2','p3','p4','p5','p6'].forEach(function(p) {
    if (data[p]) vals.push(p.toUpperCase() + ': ' + data[p] + ' kW');
  });
  return vals.length > 0 ? vals.join(' | ') : '';
}

// Necesario para que funcione como web app
function doGet() {
  return ContentService.createTextOutput('Formulario activo');
}
