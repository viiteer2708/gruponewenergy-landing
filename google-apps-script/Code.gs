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
 * 8. REMITENTE (dos vías, en este orden):
 *    A) Brevo API — clave en Propiedades del script (⚙️ Configuración del proyecto >
 *       Propiedades del script > BREVO_API_KEY). El remitente BREVO_SENDER tiene que
 *       existir en Brevo (Remitentes) con su dominio autenticado. Sin adjuntos >20MB.
 *    B) Si no hay clave o Brevo falla: GmailApp desde la cuenta que ejecuta el
 *       script, usando GMAIL_ALIAS si está dado de alta como "Enviar como"; si no,
 *       la cuenta por defecto. Lo que pase queda anotado en "Errores / notas" del Sheet.
 *
 * ORDEN DE DESPLIEGUE cuando cambian front y back a la vez: primero Vercel
 * (gnew.html), después esta nueva versión. El backend antiguo ignora los campos
 * token/ref_id, pero este nuevo RECHAZA envíos sin token: si se despliega antes
 * que el front, los envíos del HTML viejo fallarían.
 */

const EMAIL_TO = 'escaneos@gruponew.energy';
// REMITENTE. Vía A (preferida): Brevo, con la clave BREVO_API_KEY en Propiedades del
// script y BREVO_SENDER dado de alta en Brevo (dominio autenticado). Vía B (respaldo):
// GmailApp desde la cuenta que ejecuta, con GMAIL_ALIAS si está como "Enviar como".
// Todo lo que alguien escriba "al remitente" acaba en el buzón de tramitación.
const BREVO_SENDER = { name: 'Grupo New Energy - Tramitaciones', email: 'escaneos@gruponew.energy' };
const GMAIL_ALIAS = 'tramitaciones@gruponewenergy.es'; // opcional; vacío = cuenta por defecto
const MAIL_FROM_NAME = 'Grupo New Energy - Tramitaciones';
// Presupuesto de adjuntos en bytes REALES. Brevo admite 20MB por correo contando el
// base64 (+33%) y el cuerpo; Gmail 25MB de MIME. 12MB reales caben en ambos.
const ATTACH_BUDGET_RAW = 12 * 1024 * 1024;
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
      let attachments = [];
      let folder = null;
      try {
        const parentFolder = DriveApp.getFolderById(FOLDER_ID);
        const timestamp = Utilities.formatDate(new Date(), 'Europe/Madrid', 'yyyy-MM-dd HH:mm');
        const folderName = refId + ' - ' + cleanLine(data.titular || 'Sin titular').slice(0, 80) + ' - ' + cleanLine(data.compania || '').slice(0, 40) + ' - ' + timestamp;
        folder = parentFolder.createFolder(folderName);
        folderUrl = folder.getUrl();

        // Los documentos se ADJUNTAN al email para que el buzón receptor los abra
        // directamente desde el correo, SIN compartir carpetas ni pedir permisos
        // (compartir cada carpeta generaba un aviso "Carpeta compartida contigo" en
        // cada envío). El presupuesto ATTACH_BUDGET_RAW (bytes reales) cabe tanto en
        // Brevo (20MB por correo con base64) como en Gmail (25MB de MIME); se deja
        // holgura para el cuerpo HTML y las cabeceras. Todo se guarda además en Drive (cuenta que ejecuta el
        // script); lo que no quepa como adjunto se marca attached=false y, SOLO en ese
        // caso, la carpeta se comparte con el buzón receptor y el correo lleva enlace.
        // El correo NO lleva enlaces de Drive en el caso normal: la carpeta es privada
        // y quien pinchaba (tramitación, comerciales) solo generaba "solicitudes de
        // acceso" al propietario.
        let attachRaw = 0;

        archivos.forEach(function(archivo) {
          const a = archivo || {};
          const safeName = sanitizeFileName(a.name);
          const decoded = Utilities.base64Decode(String(a.data || ''));
          const blob = Utilities.newBlob(decoded, String(a.type || 'application/octet-stream'), safeName);
          const file = folder.createFile(blob);
          const cabe = attachRaw + decoded.length <= ATTACH_BUDGET_RAW;
          if (cabe) {
            attachments.push(blob);
            attachRaw += decoded.length;
          }
          fileLinks.push({
            name: safeName,
            size: cleanLine(String(a.size || '')).slice(0, 20),
            url: file.getUrl(),
            attached: cabe
          });
        });

        // La firma es opcional y secundaria: si viene malformada o desmesurada se
        // ignora, nunca debe invalidar un contrato cuyos documentos ya se subieron.
        // Se adjunta solo si cabe en el presupuesto (siempre queda en Drive).
        const firma = String(data.firma || '');
        if (firma && firma.indexOf(',') > -1 && firma.length <= MAX_FIRMA_CHARS) {
          try {
            const sigDecoded = Utilities.base64Decode(firma.split(',')[1]);
            const sigBlob = Utilities.newBlob(sigDecoded, 'image/png', 'firma.png');
            const sigFile = folder.createFile(sigBlob);
            const sigCabe = attachRaw + sigDecoded.length <= ATTACH_BUDGET_RAW;
            if (sigCabe) {
              attachments.push(sigBlob);
              attachRaw += sigDecoded.length;
            }
            fileLinks.push({ name: 'firma.png', size: '—', url: sigFile.getUrl(), attached: sigCabe });
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
        attachments = [];
      }

      // Si algún documento no cabe como adjunto, y SOLO entonces, la carpeta se
      // comparte (lectura) con el buzón receptor para que pueda abrir lo que falta.
      let folderShared = false;
      const pendientesDrive = fileLinks.filter(function (f) { return !f.attached; });
      if (folder && pendientesDrive.length > 0) {
        folderShared = shareFolderWithReceiver(folder);
        if (!folderShared) errorMsg += 'No se pudo compartir la carpeta con ' + EMAIL_TO + '; ';
      }

      // 2. EMAIL - Notificación a tramitación con los documentos ADJUNTOS (intenta 2 veces).
      //    Remitente: Brevo (BREVO_SENDER) y, si no hay clave o falla, GmailApp (respaldo).
      //    Reply-To: el comercial, para que "Responder" desde tramitación le llegue a él.
      // replyTo malformado tumbaría el envío: solo si parece un email
      const replyTo = cleanLine(data.email_comercial || '').trim();
      const replyToOk = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(replyTo);
      const subject = ('Nuevo Contrato - ' + cleanLine(data.compania || '').slice(0, 40)
        + ' - ' + cleanLine(data.quien_eres || '').slice(0, 60)
        + ' - ' + cleanLine(data.cups || '').slice(0, 25)
        + ' - ' + refId).slice(0, 200);

      let avisoRes = null;
      for (let attempt = 1; attempt <= 2; attempt++) {
        avisoRes = sendMail({
          to: EMAIL_TO,
          subject: subject,
          htmlBody: buildEmailHtml(data, fileLinks, folderUrl, refId, folderShared),
          replyTo: replyToOk ? replyTo : '',
          attachments: attachments
        });
        if (avisoRes.ok) { emailSent = true; break; }
        errorMsg += 'Email intento ' + attempt + ': ' + avisoRes.error + '; ';
        if (attempt < 2) Utilities.sleep(2000);
      }
      if (avisoRes && avisoRes.note) errorMsg += 'Aviso: ' + avisoRes.note + '; ';

      // Si el email con adjuntos no salió (p.ej. por tamaño), compartir la carpeta
      // con el receptor y enviar al menos un aviso de TEXTO con el enlace, para que
      // el buzón nunca se quede sin notificación cuando Drive sí guardó.
      if (!emailSent && driveOk) {
        if (folder && !folderShared) folderShared = shareFolderWithReceiver(folder);
        const textoRes = sendMail({
          to: EMAIL_TO,
          subject: subject,
          textBody: 'No se pudo enviar el correo con los documentos adjuntos (posible tamaño).\n\n' +
            'Ref: ' + refId + '\n' +
            'Comercial: ' + cleanLine(data.quien_eres || '') + ' <' + replyTo + '>\n' +
            'Carpeta en Drive' + (folderShared ? ' (compartida con ' + EMAIL_TO + ')' : '') + ': ' + folderUrl + '\n' +
            'Archivos: ' + fileLinks.map(function (f) { return f.name; }).join(', '),
          replyTo: replyToOk ? replyTo : '',
          attachments: []
        });
        if (textoRes.ok) emailSent = true;
        else errorMsg += 'Aviso texto: ' + textoRes.error + '; ';
      }

      // 2b. ACUSE DE RECIBO al comercial: le confirma la referencia y le dice a
      //     dónde enviar cualquier documento adicional (p. ej. la factura), con
      //     Reply-To al buzón de tramitación. Sin adjuntos ni datos bancarios.
      //     Nunca invalida el envío si falla.
      if (emailSent && replyToOk) {
        const acuseRes = sendMail({
          to: replyTo,
          subject: ('Recibido: ' + subject).slice(0, 200),
          htmlBody: buildAcuseHtml(data, refId, fileLinks),
          replyTo: EMAIL_TO,
          attachments: []
        });
        if (!acuseRes.ok) errorMsg += 'Acuse al comercial: ' + acuseRes.error + '; ';
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
        sendMail({
          to: EMAIL_TO,
          subject: 'ERROR en formulario GNEW - ' + refId,
          textBody: 'Error: ' + error.toString() +
            '\n\nDatos del envío (sin adjuntos):\n' + JSON.stringify(textOnlyData(data), null, 2).slice(0, 50000) +
            '\n\nArchivos que venían adjuntos: ' + (archivos.length > 0 ? archivos.map(function(a) { return sanitizeFileName((a || {}).name); }).join(', ') : 'ninguno'),
          attachments: []
        });
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
        'Drive OK', 'Email OK', 'Carpeta', 'Errores / notas'
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

function buildEmailHtml(data, fileLinks, folderUrl, refId, folderShared) {
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

  // Documentos: van ADJUNTOS al correo, sin enlaces (la carpeta de Drive es
  // privada; los enlaces solo generaban solicitudes de acceso). Si alguno no
  // cupo por tamaño, se avisa y se enlaza la carpeta, que en ese caso ya está
  // compartida con el buzón receptor.
  let filesHtml = '';
  if (fileLinks.length > 0) {
    const adjuntos = fileLinks.filter(function (f) { return f.attached; });
    const soloDrive = fileLinks.filter(function (f) { return !f.attached; });
    filesHtml = '<h3 style="color:#094D38;margin:24px 0 12px;font-size:15px">Documentación adjunta a este correo (' + adjuntos.length + ')</h3><ul style="list-style:none;padding:0">';
    adjuntos.forEach(function(f) {
      filesHtml += '<li style="margin:8px 0;padding:10px 14px;background:#f8fffe;border:1px solid #e2e8f0;border-radius:8px;font-size:13px">' +
        '<span style="color:#0B6E4F;font-weight:600">' + escapeHtml(f.name) + '</span>' +
        '<span style="color:#6B7280;margin-left:8px">' + escapeHtml(f.size) + '</span>' +
      '</li>';
    });
    filesHtml += '</ul>';
    if (soloDrive.length > 0) {
      filesHtml += '<div style="margin-top:12px;padding:12px 14px;background:#FFF7ED;border:1px solid #FDBA74;border-radius:8px;font-size:13px;color:#7C2D12">' +
        '<strong>' + soloDrive.length + ' archivo(s) superan el tamaño del correo y quedan solo en Drive:</strong> ' +
        escapeHtml(soloDrive.map(function (f) { return f.name; }).join(', ')) + '. ' +
        (folderShared
          ? '<a href="' + escapeHtml(folderUrl) + '" style="color:#0B6E4F;font-weight:600">Abrir carpeta en Google Drive</a> (compartida con ' + escapeHtml(EMAIL_TO) + ').'
          : 'No se pudo compartir la carpeta automáticamente: pídesela al propietario del formulario.') +
      '</div>';
    }
  }

  const pie = '<div style="margin-top:20px;padding-top:14px;border-top:1px solid #e2e8f0;font-size:12px;color:#6B7280;line-height:1.5">' +
    'Al <strong>responder</strong> a este correo, la respuesta le llega directamente al comercial' +
    (data.email_comercial ? ' (' + escapeHtml(cleanLine(data.email_comercial)) + ')' : '') + '. ' +
    'El comercial recibe un acuse de recibo con la indicación de enviar cualquier documento adicional a ' + escapeHtml(EMAIL_TO) + ' citando la referencia.<br>' +
    'Aviso automático de tramitatucontrato.energy.' +
  '</div>';

  return '<div style="font-family:Arial,sans-serif;max-width:650px;margin:0 auto">' +
    '<div style="background:#094D38;color:#fff;padding:20px 24px;border-radius:10px 10px 0 0">' +
      '<h2 style="margin:0;font-size:18px">Nuevo Contrato para Tramitar</h2>' +
      '<p style="margin:6px 0 0;opacity:.8;font-size:13px">' + Utilities.formatDate(new Date(), 'Europe/Madrid', "dd/MM/yyyy 'a las' HH:mm") + ' — Ref: ' + refId + '</p>' +
    '</div>' +
    '<div style="background:#fff;padding:24px;border:1px solid #e2e8f0;border-top:none;border-radius:0 0 10px 10px">' +
      '<table style="width:100%;border-collapse:collapse">' + rows + '</table>' +
      filesHtml +
      pie +
    '</div>' +
  '</div>';
}

// Acuse de recibo para el comercial: referencia, resumen (sin IBAN ni DNI) y,
// sobre todo, A DÓNDE enviar la documentación que falte. Se manda con
// Reply-To = EMAIL_TO, así "responder" ya llega a tramitación.
function buildAcuseHtml(data, refId, fileLinks) {
  const fields = [
    ['Referencia', refId],
    ['Fecha', Utilities.formatDate(new Date(), 'Europe/Madrid', "dd/MM/yyyy 'a las' HH:mm")],
    ['Compañía', data.compania],
    ['CUPS', data.cups],
    ['Titular / Razón Social', data.titular],
    ['Oferta', data.oferta],
    ['Tarifa', data.tarifa]
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
  let docsHtml = '';
  if (fileLinks.length > 0) {
    docsHtml = '<h3 style="color:#094D38;margin:24px 0 12px;font-size:15px">Documentación recibida (' + fileLinks.length + ')</h3><ul style="margin:0;padding-left:20px;font-size:13px;color:#374151">' +
      fileLinks.map(function (f) { return '<li style="margin:4px 0">' + escapeHtml(f.name) + '</li>'; }).join('') +
      '</ul>';
  }
  const nombre = cleanLine(data.quien_eres || '').trim();
  return '<div style="font-family:Arial,sans-serif;max-width:650px;margin:0 auto">' +
    '<div style="background:#094D38;color:#fff;padding:20px 24px;border-radius:10px 10px 0 0">' +
      '<h2 style="margin:0;font-size:18px">Contrato recibido</h2>' +
      '<p style="margin:6px 0 0;opacity:.8;font-size:13px">Ref: ' + refId + '</p>' +
    '</div>' +
    '<div style="background:#fff;padding:24px;border:1px solid #e2e8f0;border-top:none;border-radius:0 0 10px 10px;font-size:14px;color:#111827;line-height:1.5">' +
      '<p style="margin:0 0 16px">Hola' + (nombre ? ' ' + escapeHtml(nombre) : '') + ', hemos recibido tu contrato y la documentación adjunta. Ya está en manos del equipo de tramitación.</p>' +
      '<table style="width:100%;border-collapse:collapse">' + rows + '</table>' +
      docsHtml +
      '<div style="margin-top:20px;padding:14px 16px;background:#f0faf6;border:1px solid #bbf7d0;border-radius:8px;font-size:13px">' +
        '<strong>¿Falta algo o quieres añadir documentación?</strong><br>' +
        'Si el equipo de tramitación necesita algún documento más (por ejemplo, la <strong>factura</strong>), te escribirá desde <strong>' + escapeHtml(EMAIL_TO) + '</strong>. ' +
        'Para enviar documentación adicional o preguntar por el estado, <strong>responde a este correo</strong> o escribe a ' +
        '<a href="mailto:' + escapeHtml(EMAIL_TO) + '" style="color:#0B6E4F;font-weight:600">' + escapeHtml(EMAIL_TO) + '</a> ' +
        'indicando siempre la referencia <strong>' + refId + '</strong>.' +
      '</div>' +
      '<p style="margin:16px 0 0;font-size:12px;color:#6B7280">Correo automático de tramitatucontrato.energy (Grupo New Energy). Guarda la referencia para cualquier consulta.</p>' +
    '</div>' +
  '</div>';
}

// ---------------------------------------------------------------------------
// CAPA DE ENVÍO. sendMail({to, subject, htmlBody|textBody, replyTo, attachments})
// devuelve {ok, via, error, note}. Vía A: Brevo (si hay BREVO_API_KEY). Vía B: Gmail.
// Nunca lanza: los fallos se devuelven en 'error' para que doPost decida.
// ---------------------------------------------------------------------------
function sendMail(msg) {
  const key = getBrevoKey();
  let brevoErr = '';
  if (key) {
    const r = sendViaBrevo(msg, key);
    if (r.ok) return { ok: true, via: 'brevo', error: '', note: '' };
    brevoErr = r.error;
  }
  const g = sendViaGmail(msg);
  const note = key
    ? 'vía Gmail (respaldo) porque Brevo falló: ' + brevoErr
    : 'vía Gmail (falta BREVO_API_KEY en Propiedades del script)';
  if (g.ok) return { ok: true, via: 'gmail', error: '', note: note };
  return { ok: false, via: '', error: (brevoErr ? 'Brevo: ' + brevoErr + ' | ' : '') + 'Gmail: ' + g.error, note: '' };
}

// Clave de Brevo, por este orden: 1) Propiedades del script `BREVO_API_KEY`;
// 2) fichero privado CONFIG_FILE_NAME dentro de FOLDER_ID (solo lo ve la cuenta
// propietaria; NO compartirlo) con {"BREVO_API_KEY": "..."}, cacheado 1h.
// Sin clave por ninguna vía → respaldo Gmail.
const CONFIG_FILE_NAME = 'config-formulario.json';
var brevoKeyCache = null;
function getBrevoKey() {
  if (brevoKeyCache !== null) return brevoKeyCache;
  let key = '';
  try {
    key = String(PropertiesService.getScriptProperties().getProperty('BREVO_API_KEY') || '').trim();
  } catch (e) {}
  if (!key) {
    try {
      const cache = CacheService.getScriptCache();
      const cached = cache.get('brevo_key');
      if (cached) {
        key = cached;
      } else {
        const files = DriveApp.getFolderById(FOLDER_ID).getFilesByName(CONFIG_FILE_NAME);
        if (files.hasNext()) {
          const cfg = JSON.parse(files.next().getBlob().getDataAsString('UTF-8') || '{}');
          key = String(cfg.BREVO_API_KEY || '').trim();
          if (key) cache.put('brevo_key', key, 3600);
        }
      }
    } catch (e) {}
  }
  brevoKeyCache = key;
  return key;
}

// Brevo API v3 (transaccional). Los adjuntos van en base64 dentro del JSON.
function sendViaBrevo(msg, key) {
  try {
    const body = {
      sender: { name: BREVO_SENDER.name, email: BREVO_SENDER.email },
      to: [{ email: msg.to }],
      subject: msg.subject
    };
    if (msg.htmlBody) body.htmlContent = msg.htmlBody;
    else body.textContent = msg.textBody || '';
    if (msg.replyTo) body.replyTo = { email: msg.replyTo };
    if (msg.attachments && msg.attachments.length > 0) {
      body.attachment = msg.attachments.map(function (b) {
        return { name: b.getName(), content: Utilities.base64Encode(b.getBytes()) };
      });
    }
    const res = UrlFetchApp.fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'post',
      contentType: 'application/json',
      headers: { 'api-key': key, 'accept': 'application/json' },
      payload: JSON.stringify(body),
      muteHttpExceptions: true
    });
    const code = res.getResponseCode();
    if (code >= 200 && code < 300) return { ok: true, error: '' };
    return { ok: false, error: 'HTTP ' + code + ' ' + String(res.getContentText() || '').slice(0, 200) };
  } catch (e) {
    return { ok: false, error: e.toString().slice(0, 200) };
  }
}

// GmailApp desde la cuenta que ejecuta el script. Usa GMAIL_ALIAS solo si está
// dado de alta como "Enviar como" (con un from desconocido GmailApp lanza error).
var gmailAliasCache = null;
function gmailFromAlias() {
  if (gmailAliasCache !== null) return gmailAliasCache;
  gmailAliasCache = '';
  if (GMAIL_ALIAS) {
    try {
      const aliases = GmailApp.getAliases().map(function (a) { return String(a).toLowerCase(); });
      if (aliases.indexOf(GMAIL_ALIAS.toLowerCase()) > -1) gmailAliasCache = GMAIL_ALIAS;
    } catch (aliasErr) {}
  }
  return gmailAliasCache;
}
function sendViaGmail(msg) {
  try {
    const opts = { name: MAIL_FROM_NAME };
    if (msg.htmlBody) opts.htmlBody = msg.htmlBody;
    if (msg.replyTo) opts.replyTo = msg.replyTo;
    if (msg.attachments && msg.attachments.length > 0) opts.attachments = msg.attachments;
    const alias = gmailFromAlias();
    if (alias) opts.from = alias;
    GmailApp.sendEmail(msg.to, msg.subject, msg.textBody || '', opts);
    return { ok: true, error: '' };
  } catch (e) {
    return { ok: false, error: e.toString().slice(0, 200) };
  }
}

// Comparte la carpeta del contrato (solo lectura) con el buzón receptor. Solo se
// usa cuando algún documento no ha podido ir adjunto al correo.
function shareFolderWithReceiver(folder) {
  try {
    folder.addViewer(EMAIL_TO);
    return true;
  } catch (shareErr) {
    return false;
  }
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

// Diagnóstico manual (ejecutar desde el editor cuando el aviso salga "vía Gmail
// (respaldo)"): comprueba si el script encuentra la clave de Brevo y si tiene
// permiso para llamar a servicios externos. Si sale "no autorizado", revocar el
// acceso del proyecto en myaccount.google.com/permissions y volver a ejecutar
// para que Google vuelva a pedir TODOS los permisos.
function diagnosticoBrevo() {
  const key = getBrevoKey();
  Logger.log('Clave Brevo: ' + (key ? 'ENCONTRADA (' + key.slice(0, 10) + '…)' : 'NO ENCONTRADA'));
  try {
    const r = UrlFetchApp.fetch('https://api.brevo.com/v3/account', { headers: { 'api-key': key }, muteHttpExceptions: true });
    Logger.log('UrlFetch OK, HTTP ' + r.getResponseCode() + ' ' + String(r.getContentText()).slice(0, 80));
  } catch (e) {
    Logger.log('UrlFetch ERROR: ' + e);
  }
}
