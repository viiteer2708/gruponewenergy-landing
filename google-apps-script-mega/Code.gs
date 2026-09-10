/**
 * MEGA ENERGIA - Backend para formulario de tramitación (mega.html)
 *
 * SETUP / REDESPLIEGUE:
 * 1. Abre el proyecto Apps Script "Mega Energia - Formulario"
 * 2. Pega este código en Code.gs y guarda
 * 3. FORM_TOKEN debe coincidir con el de mega.html
 * 4. "Implementar" > "Administrar implementaciones" > editar (lápiz) > Nueva versión
 *    (editar mantiene la MISMA URL; crear una nueva la cambiaría)
 * 5. Ejecutar como: "Yo" · Acceso: "Cualquier persona" (imprescindible: el
 *    navegador lee la respuesta JSON para confirmar el envío)
 * 6. REMITENTE (dos vías, en este orden):
 *    A) Brevo API — clave en Propiedades del script (⚙️ Configuración del proyecto >
 *       Propiedades del script > BREVO_API_KEY). El remitente BREVO_SENDER tiene que
 *       existir en Brevo (Remitentes) con su dominio autenticado. Sin adjuntos >20MB.
 *    B) Si no hay clave o Brevo falla: GmailApp desde la cuenta que ejecuta el
 *       script, usando GMAIL_ALIAS si está dado de alta como "Enviar como"; si no,
 *       la cuenta por defecto. Lo que pase queda anotado en "Errores / notas" del Sheet.
 *
 * ORDEN DE DESPLIEGUE cuando cambian front y back: primero Vercel (mega.html),
 * después esta nueva versión (el back nuevo exige token; el viejo ignora los
 * campos nuevos).
 *
 * CAMBIO 10-sep-2026 (rendimiento): el candado global ya NO se mantiene durante
 * todo el proceso (solo milisegundos, para la dedup); el contrato se marca como
 * tramitado en cuanto está en Drive + avisado; el registro en la hoja va por la
 * API REST de Sheets (acotada) con cola de respaldo; y los fallos transitorios
 * responden retryable:true para que el front reintente con el mismo ref_id.
 * No requiere permisos nuevos (mismos oauthScopes de appsscript.json).
 */

const EMAIL_TO = 'administracion@megaenergia.es';
// REMITENTE. Vía A (preferida): Brevo, con la clave BREVO_API_KEY en Propiedades del
// script y BREVO_SENDER dado de alta en Brevo (dominio autenticado). Vía B (respaldo):
// GmailApp desde la cuenta que ejecuta, con GMAIL_ALIAS si está como "Enviar como".
// Todo lo que alguien escriba "al remitente" acaba en el buzón de administración.
const BREVO_SENDER = { name: 'Mega Energia - Tramitaciones', email: 'administracion@megaenergia.es' };
const GMAIL_ALIAS = 'tramitaciones@megaenergia.es'; // opcional; vacío = cuenta por defecto
const MAIL_FROM_NAME = 'Mega Energia - Tramitaciones';
// Presupuesto de adjuntos en bytes REALES. Brevo admite 20MB por correo contando el
// base64 (+33%) y el cuerpo; Gmail 25MB de MIME. 12MB reales caben en ambos.
const ATTACH_BUDGET_RAW = 12 * 1024 * 1024;
const FOLDER_ID = '1cfxHV8Oz_N9wsG6E9MRM_74dMSiioXUx'; // "Contratos Mega Energia"
const FORM_TOKEN = 'MEGA-2026-h3p8k5z1q6'; // debe coincidir con mega.html
const ALLOWED_EXTENSIONS = ['pdf', 'jpg', 'jpeg', 'png', 'doc', 'docx'];
const MAX_FILES = 15; // debe coincidir con MAX_FILES de mega.html
// mega.html limita los adjuntos a 30MB reales (~40M caracteres en base64).
// Margen hasta 45M antes de rechazar por tamaño.
const MAX_TOTAL_BASE64_CHARS = 45 * 1024 * 1024;
const MAX_FIRMA_CHARS = 2 * 1024 * 1024;

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
  const refId = (typeof data.ref_id === 'string' && /^MEGA-\d{8}-[A-Z0-9]{4,10}$/.test(data.ref_id))
    ? data.ref_id
    : generateRefId();

  // Honeypot relleno = bot (o, raro, autofill de un navegador): éxito falso para
  // no dar pistas, pero CON rastro en el Sheet por si fuera un falso positivo
  if (data.hp) {
    logToSheet(refId, data, 0, false, false, '', 'HONEYPOT: campo oculto relleno con "' + cleanLine(String(data.hp)).slice(0, 50) + '"');
    return jsonResponse({ success: true, refId: refId });
  }

  // Límites server-side de la documentación, ANTES del lock (rechazos baratos)
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

  // ===== IDEMPOTENCIA SIN CANDADO LARGO (10-sep-2026) =====
  // Antes el candado global se mantenía durante TODO el proceso (Drive + correos +
  // hoja de registro). El 10-sep-2026 la escritura en la hoja se atascó (3 min en
  // un envío, más de 6 en otro, que murió por el límite de Apps Script): el propio
  // comercial vio "Enviando contrato..." durante minutos, su navegador reintentó y
  // el contrato entró DOS veces, y los demás comerciales esperaron en cola hasta 2
  // minutos para acabar en "Servidor ocupado". Ahora el candado solo protege la
  // comprobación de duplicado y la marca "en curso" (milisegundos); el trabajo
  // pesado va sin candado y el contrato se marca como tramitado en cuanto está a
  // salvo (Drive + aviso), ANTES del acuse y del registro.
  const cache = CacheService.getScriptCache();
  let estado = claimRef(cache, refId);
  if (estado === 'inflight') {
    // Reintento del navegador (timeout o corte de red) con la primera ejecución
    // aún en curso: esperar a que termine en vez de duplicar el contrato
    estado = waitForRef(cache, refId);
  }
  if (estado === 'lock') {
    return jsonResponse({ success: false, retryable: true, error: 'Servidor ocupado, vuelve a intentarlo en unos segundos', refId: refId });
  }
  if (estado === 'done') {
    return jsonResponse({ success: true, refId: refId, duplicated: true });
  }
  if (estado === 'inflight') {
    return jsonResponse({ success: false, retryable: true, error: 'Tu envío anterior todavía se está procesando, espera unos segundos', refId: refId });
  }
  // estado === 'claimed': esta ejecución tramita el contrato

  let folderUrl = '';
  let emailSent = false;
  let driveOk = false;
  let errorMsg = '';
  let marcado = false; // true en cuanto el contrato está a salvo y marcado como tramitado

  try {
    // 1. GOOGLE DRIVE - Guardar archivos
    let fileLinks = [];
    let attachments = [];
    let folder = null;
    try {
      const parentFolder = DriveApp.getFolderById(FOLDER_ID);
      const timestamp = Utilities.formatDate(new Date(), 'Europe/Madrid', 'yyyy-MM-dd HH:mm');
      const folderName = refId + ' - ' + cleanLine(data.titular || 'Sin titular').slice(0, 80) + ' - ' + timestamp;
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
      // y quien pinchaba (administración, comerciales) solo generaba "solicitudes de
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

    // 2. EMAIL - Notificación a administración con los documentos ADJUNTOS (intenta 2 veces).
    //    Remitente: Brevo (BREVO_SENDER) y, si no hay clave o falla, GmailApp (respaldo).
    //    Reply-To: el comercial, para que "Responder" desde administración le llegue a él.
    // replyTo malformado tumbaría el envío: solo si parece un email
    const replyTo = cleanLine(data.email_comercial || '').trim();
    const replyToOk = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(replyTo);
    const subject = ('Nuevo Contrato MEGA - ' + cleanLine(data.quien_eres || '').slice(0, 60)
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
    if (!driveOk) {
      throw new Error(errorMsg || 'No se pudieron guardar los archivos');
    }

    // Contrato A SALVO (Drive + aviso). Se marca como tramitado YA, antes del acuse
    // y del registro, para que un reintento del navegador nunca lo duplique aunque
    // alguno de los pasos siguientes se atasque o esta ejecución muera.
    cache.put('ref:' + refId, 'done', 21600); // 6h, máximo de CacheService
    marcado = true;

    // 2b. ACUSE DE RECIBO al comercial: le confirma la referencia y le dice a
    //     dónde enviar cualquier documento adicional (p. ej. la factura), con
    //     Reply-To al buzón de administración. Sin adjuntos ni datos bancarios.
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
    // 3. REGISTRO en la hoja — tercera pata de la "triple seguridad". Va por la
    //    API REST de Sheets (acotada en tiempo); si falla, la fila queda en cola y
    //    se vuelca en el siguiente envío. Nunca retiene al navegador minutos.
    logToSheet(refId, data, archivos.length, driveOk, emailSent, folderUrl, errorMsg);
    flushPendingLogRows();

    return jsonResponse({
      success: true,
      refId: refId,
      emailSent: emailSent,
      driveOk: true
    });

  } catch (error) {
    if (marcado) {
      // El contrato ya estaba guardado y avisado: un fallo posterior (acuse,
      // registro) no debe convertirse en un error para el comercial
      try { logToSheet(refId, data, archivos.length, true, emailSent, folderUrl, errorMsg + 'Tras guardar: ' + error.toString().slice(0, 200)); } catch (logErr) {}
      return jsonResponse({ success: true, refId: refId, emailSent: emailSent, driveOk: true });
    }

    // Liberar la marca "en curso" para que el reintento pueda volver a procesarlo
    try { cache.remove('ref:' + refId); } catch (rmErr) {}
    try { logToSheet(refId, data, archivos.length, driveOk, emailSent, folderUrl, 'ERROR: ' + error.toString().slice(0, 200) + '; ' + errorMsg); } catch (logErr) {}

    // Último recurso: email de error con todos los datos de texto (sin base64)
    try {
      sendMail({
        to: EMAIL_TO,
        subject: 'ERROR en formulario MEGA - ' + refId,
        textBody: 'Error: ' + error.toString() +
          '\n\nDatos del envío (sin adjuntos):\n' + JSON.stringify(textOnlyData(data), null, 2).slice(0, 50000) +
          '\n\nArchivos que venían adjuntos: ' + (archivos.length > 0 ? archivos.map(function(a) { return sanitizeFileName((a || {}).name); }).join(', ') : 'ninguno'),
        attachments: []
      });
    } catch (lastErr) {}

    // Al cliente, mensaje genérico: el detalle (stacktrace, ids internos) ya
    // viaja en el email de error y no debe exponerse en un endpoint público.
    // retryable: el front puede volver a intentarlo con el mismo ref_id.
    return jsonResponse({ success: false, retryable: true, error: 'No se pudo guardar la documentación. Inténtalo de nuevo o envíala por email a ' + EMAIL_TO, refId: refId });
  }
}

// Marca "en curso" que sobrevive a una ejecución que muera a medias (límite de
// 6 min de Apps Script): pasado este tiempo, un reintento vuelve a procesar.
const INFLIGHT_TTL_S = 420;

// Reclama el refId bajo candado (milisegundos). Devuelve:
//  'done'     → ya tramitado con éxito (no repetir)
//  'inflight' → otra ejecución lo está procesando ahora mismo
//  'claimed'  → esta ejecución se lo queda
//  'lock'     → no se pudo obtener el candado (servidor saturado)
function claimRef(cache, refId) {
  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(20000);
  } catch (lockTimeout) {
    return 'lock';
  }
  try {
    const v = cache.get('ref:' + refId);
    if (v === 'done' || v === '1') return 'done'; // '1' = marca de la versión anterior
    if (v === 'inflight') return 'inflight';
    cache.put('ref:' + refId, 'inflight', INFLIGHT_TTL_S);
    return 'claimed';
  } finally {
    lock.releaseLock();
  }
}

// Espera (máx. 45 s) a que la ejecución en curso del mismo refId termine.
function waitForRef(cache, refId) {
  const deadline = Date.now() + 45000;
  while (Date.now() < deadline) {
    Utilities.sleep(3000);
    const v = cache.get('ref:' + refId);
    if (v === 'done' || v === '1') return 'done';
    if (!v) return claimRef(cache, refId); // la primera murió sin terminar: la retomamos
  }
  return 'inflight';
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
  return 'MEGA-' + date + '-' + rand;
}

// Todo lo que se pinta en el email pasa por aquí: endpoint público, nadie debe
// poder inyectar HTML/enlaces en el correo
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

// Sheets interpreta como fórmula lo que empieza por = + - @ (incluido "+34..."):
// prefijar apóstrofo lo fuerza a texto literal
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
//
// 10-sep-2026: la fila se añade por la API REST de Sheets (UrlFetch, acotada en
// tiempo) en vez de SpreadsheetApp.appendRow, que ese día se quedó colgado 3 min
// y más de 6 min y retuvo al navegador del comercial. Si la API falla, la fila se
// guarda en cola (ScriptProperties) y se vuelca en el siguiente envío.
function logToSheet(refId, data, numArchivos, driveOk, emailSent, folderUrl, errorMsg) {
  try {
    const row = [
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
    ];
    const props = PropertiesService.getScriptProperties();
    let ssId = props.getProperty('LOG_SHEET_ID');
    if (!ssId) {
      // Solo la primera vez: crear la hoja con su cabecera (aquí sí vía SpreadsheetApp)
      const ss = SpreadsheetApp.create('Registro Tramitaciones MEGA');
      DriveApp.getFileById(ss.getId()).moveTo(DriveApp.getFolderById(FOLDER_ID));
      ss.getSheets()[0].appendRow([
        'Fecha', 'Ref', 'Comercial', 'Email comercial', 'Compañía', 'CUPS', 'Titular',
        'CIF/NIF', 'Móvil', 'Email cliente', 'IBAN (enmascarado)', 'Nº archivos',
        'Drive OK', 'Email OK', 'Carpeta', 'Errores / notas'
      ]);
      ssId = ss.getId();
      props.setProperty('LOG_SHEET_ID', ssId);
    }
    if (!appendRowRest(ssId, row)) queuePendingLogRow(refId, row);
  } catch (logErr) {
    // El registro nunca debe tumbar la tramitación
  }
}

// Añade una fila al final de la primera pestaña con la API REST de Sheets.
// USER_ENTERED = mismo comportamiento que appendRow (el apóstrofo de sheetSafe
// sigue neutralizando fórmulas). El token lleva el scope "spreadsheets" que el
// proyecto ya tiene concedido (appsscript.json); no pide permisos nuevos.
function appendRowRest(ssId, row) {
  try {
    const url = 'https://sheets.googleapis.com/v4/spreadsheets/' + encodeURIComponent(ssId)
      + '/values/' + encodeURIComponent('A:P') + ':append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS';
    const res = UrlFetchApp.fetch(url, {
      method: 'post',
      contentType: 'application/json',
      headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() },
      payload: JSON.stringify({ values: [row] }),
      muteHttpExceptions: true
    });
    const code = res.getResponseCode();
    return code >= 200 && code < 300;
  } catch (e) {
    return false;
  }
}

// Cola de filas pendientes (una propiedad por fila: el límite es 9KB por valor).
const PENDING_LOG_PREFIX = 'PENDING_LOG_';
function queuePendingLogRow(refId, row) {
  try {
    PropertiesService.getScriptProperties().setProperty(PENDING_LOG_PREFIX + Date.now() + '_' + refId, JSON.stringify(row));
  } catch (e) {}
}

// Vuelca hasta 5 filas pendientes (acotado: cada una es una llamada REST).
function flushPendingLogRows() {
  try {
    const props = PropertiesService.getScriptProperties();
    const ssId = props.getProperty('LOG_SHEET_ID');
    if (!ssId) return;
    const all = props.getProperties();
    const keys = Object.keys(all).filter(function (k) { return k.indexOf(PENDING_LOG_PREFIX) === 0; }).sort().slice(0, 5);
    keys.forEach(function (k) {
      let row;
      try { row = JSON.parse(all[k]); } catch (e) { props.deleteProperty(k); return; }
      if (appendRowRest(ssId, row)) props.deleteProperty(k);
    });
  } catch (e) {}
}

// Diagnóstico manual (ejecutar desde el editor): comprueba que el script llega a
// la hoja de registro por la API REST con su permiso actual. No escribe nada.
function diagnosticoRegistro() {
  const props = PropertiesService.getScriptProperties();
  const ssId = props.getProperty('LOG_SHEET_ID');
  Logger.log('LOG_SHEET_ID: ' + (ssId || 'NO DEFINIDO (se creará la hoja en el primer envío)'));
  if (!ssId) return;
  try {
    const res = UrlFetchApp.fetch('https://sheets.googleapis.com/v4/spreadsheets/' + encodeURIComponent(ssId) + '?fields=properties.title',
      { headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() }, muteHttpExceptions: true });
    Logger.log('Sheets API HTTP ' + res.getResponseCode() + ' ' + String(res.getContentText()).slice(0, 120));
  } catch (e) {
    Logger.log('Sheets API ERROR: ' + e);
  }
  const pend = Object.keys(props.getProperties()).filter(function (k) { return k.indexOf(PENDING_LOG_PREFIX) === 0; }).length;
  Logger.log('Filas pendientes de volcar: ' + pend);
}

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

function doGet() {
  return ContentService.createTextOutput('Formulario Mega Energia activo');
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
