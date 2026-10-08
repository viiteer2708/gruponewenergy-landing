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
 *    A) Altavoz (API de avisos) — clave en Propiedades del script (⚙️ Configuración
 *       del proyecto > Propiedades del script > ALTAVOZ_API_KEY) o en el fichero
 *       privado config-formulario.json de la carpeta de Drive. El remitente lo pone
 *       Altavoz (el de la marca ALTAVOZ_MARCA). Adjuntos: 3 MB reales y 10 en total.
 *    B) Si no hay clave o Altavoz no acepta el aviso: GmailApp desde la cuenta que
 *       ejecuta el script, usando GMAIL_ALIAS si está dado de alta como "Enviar como";
 *       si no, la cuenta por defecto. Lo que pase queda anotado en "Errores / notas" del Sheet.
 *
 * ORDEN DE DESPLIEGUE cuando cambian front y back a la vez: primero Vercel
 * (gnew.html), después esta nueva versión. El backend antiguo ignora los campos
 * token/ref_id, pero este nuevo RECHAZA envíos sin token: si se despliega antes
 * que el front, los envíos del HTML viejo fallarían.
 *
 * CAMBIO 10-sep-2026 (rendimiento): el candado global ya NO se mantiene durante
 * todo el proceso (solo milisegundos, para la dedup); el contrato se marca como
 * tramitado en cuanto está en Drive + avisado; el registro en la hoja va por la
 * API REST de Sheets (acotada) con cola de respaldo; y los fallos transitorios
 * responden retryable:true para que el front reintente con el mismo ref_id.
 * No requiere permisos nuevos (mismos oauthScopes de appsscript.json).
 *
 * CAMBIO 8-oct-2026 (mañana): (a) se reponen las funciones de correo (buildEmailHtml,
 * buildAcuseHtml, sendMail, gmailFromAlias, sendViaGmail y las de la vía A de entonces),
 * que se perdieron en este fichero con el cambio del 10-sep: la copia del repo NO podía
 * mandar ningún correo (el script publicado seguía con la versión anterior); (b) cada
 * carpeta de Drive guarda datos-formulario.txt con los datos del envío. Brevo se dio de
 * baja el 8-oct-2026 (se quedó sin créditos y aceptaba sin enviar); los 31 avisos perdidos
 * del 7/8-oct se reenviaron desde el VPS por Amazon SES (cuenta de Altavoz).
 *
 * CAMBIO 8-oct-2026 (tarde): el correo sale por ALTAVOZ (vía A) y Gmail queda solo de
 * respaldo (vía B). Se quitó toda la vía Brevo.
 *  - Vía A: POST ALTAVOZ_URL con ALTAVOZ_MARCA; el remitente lo pone Altavoz. Un 2xx =
 *    Amazon lo aceptó; cualquier otro código = no salió y el aviso se manda por Gmail,
 *    con el motivo en "Errores / notas" del Sheet. Con el «modo prueba» de Altavoz
 *    encendido TODOS los avisos salen por Gmail (409 modo_prueba): es lo correcto.
 *  - Adjuntos: topes de Altavoz: ATTACH_BUDGET_RAW = 3.000.000 bytes reales entre todos y
 *    ATTACH_MAX_COUNT = 10 adjuntos en total, firma incluida; un documento o la firma solo
 *    va adjunto si cabe en bytes Y quedan plazas (documentos primero, firma después). Lo
 *    que no va adjunto queda solo en Drive: la carpeta se comparte con el buzón receptor
 *    y el correo lleva el enlace (decisión de Victor).
 *  - Acuse al comercial a una dirección BLOQUEADA en Altavoz (409 destinatario_suprimido):
 *    NO se reintenta por Gmail (se saltaría el bloqueo); queda en "Errores / notas" como
 *    «Acuse al comercial: Altavoz: dirección bloqueada (…)» y el contrato sigue siendo
 *    success. El aviso al buzón, el aviso de texto y el correo de error SÍ caen a Gmail.
 *  - Clave: Propiedades del script ALTAVOZ_API_KEY, o config-formulario.json en la
 *    carpeta de Drive con {"ALTAVOZ_API_KEY": "av_…"} (cacheada 1 h). Sin clave → Gmail.
 *  - Etiquetas: tramitacion-aviso, tramitacion-acuse, tramitacion-aviso-texto y
 *    tramitacion-error.
 *  - diagnosticoAltavoz() (desde el editor): comprueba la clave y el permiso y manda una
 *    prueba con adjunto a victor.molins.10+formulario@gmail.com.
 *  - Sin permisos nuevos: Altavoz usa el mismo scope script.external_request.
 */

const EMAIL_TO = 'escaneos@gruponew.energy';
// REMITENTE. Vía A (preferida): Altavoz (API de avisos); el remitente lo pone Altavoz
// (el de la marca) y no se manda. Vía B (respaldo): GmailApp desde la cuenta que ejecuta,
// con GMAIL_ALIAS si está como "Enviar como". Brevo se dio de baja el 8-oct-2026.
const ALTAVOZ_URL = 'https://altavoz.gruponewenergy.es/api/v1/avisos';
const ALTAVOZ_MARCA = 'GNEW';
const GMAIL_ALIAS = 'tramitaciones@gruponewenergy.es'; // opcional; vacío = cuenta por defecto
const MAIL_FROM_NAME = 'Grupo New Energy - Tramitaciones';
// Topes de adjuntos de un aviso (los de Altavoz). ATTACH_BUDGET_RAW: bytes REALES sumados
// todos, 3.000.000 (y una petición de más de ~4,5 MB la corta Vercel con 413: 3 MB reales
// son ~4 MB en base64 + el HTML). ATTACH_MAX_COUNT: como mucho 10 adjuntos EN TOTAL, firma
// incluida (con más, Altavoz responde 422). Un documento o la firma solo va adjunto si cabe
// en bytes Y quedan plazas, por orden de llegada: documentos primero, firma después. Lo que
// no va adjunto queda solo en Drive: la carpeta se comparte con el buzón receptor y el
// correo lleva el enlace (decisión de Victor 8-oct-2026: «si es demasiado grande, el enlace
// de Drive»). El respaldo Gmail lleva los mismos adjuntos.
const ATTACH_BUDGET_RAW = 3000000;
const ATTACH_MAX_COUNT = 10;
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
      const folderName = refId + ' - ' + cleanLine(data.titular || 'Sin titular').slice(0, 80) + ' - ' + cleanLine(data.compania || '').slice(0, 40) + ' - ' + timestamp;
      folder = parentFolder.createFolder(folderName);
      folderUrl = folder.getUrl();

      // Los documentos se ADJUNTAN al email para que el buzón receptor los abra
      // directamente desde el correo, SIN compartir carpetas ni pedir permisos
      // (compartir cada carpeta generaba un aviso "Carpeta compartida contigo" en
      // cada envío). Los topes ATTACH_BUDGET_RAW (bytes reales, entre todos los adjuntos)
      // y ATTACH_MAX_COUNT (nº de adjuntos, firma incluida) son los de Altavoz y también
      // caben de sobra en Gmail. Todo se guarda además en Drive (cuenta que ejecuta el
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
        const cabe = attachRaw + decoded.length <= ATTACH_BUDGET_RAW && attachments.length < ATTACH_MAX_COUNT;
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
      // Se adjunta solo si cabe en bytes Y queda plaza (siempre queda en Drive).
      const firma = String(data.firma || '');
      if (firma && firma.indexOf(',') > -1 && firma.length <= MAX_FIRMA_CHARS) {
        try {
          const sigDecoded = Utilities.base64Decode(firma.split(',')[1]);
          const sigBlob = Utilities.newBlob(sigDecoded, 'image/png', 'firma.png');
          const sigFile = folder.createFile(sigBlob);
          const sigCabe = attachRaw + sigDecoded.length <= ATTACH_BUDGET_RAW && attachments.length < ATTACH_MAX_COUNT;
          if (sigCabe) {
            attachments.push(sigBlob);
            attachRaw += sigDecoded.length;
          }
          fileLinks.push({ name: 'firma.png', size: '—', url: sigFile.getUrl(), attached: sigCabe });
        } catch (sigErr) {
          errorMsg += 'Firma ignorada: ' + sigErr.toString() + '; ';
        }
      }

      // Copia de los datos del formulario (sin documentos, firma ni token) junto a
      // los archivos. Hasta el 8-oct-2026 solo viajaban en el correo: cuando Brevo
      // se quedó sin créditos y los avisos no salieron, no había forma de recuperar
      // IBAN, dirección o potencias. La carpeta es privada. Nunca invalida el envío.
      try {
        folder.createFile(Utilities.newBlob(JSON.stringify(textOnlyData(data), null, 2), 'text/plain', 'datos-formulario.txt'));
      } catch (datosErr) {
        errorMsg += 'Copia de datos no guardada en Drive: ' + datosErr.toString().slice(0, 100) + '; ';
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
    //    Vía A: Altavoz (remitente de la marca) y, si no hay clave o falla, GmailApp (respaldo).
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
        etiqueta: 'tramitacion-aviso',
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
        etiqueta: 'tramitacion-aviso-texto',
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
    //     Reply-To al buzón de tramitación. Sin adjuntos ni datos bancarios.
    //     Nunca invalida el envío si falla.
    if (emailSent && replyToOk) {
      const acuseRes = sendMail({
        to: replyTo,
        subject: ('Recibido: ' + subject).slice(0, 200),
        htmlBody: buildAcuseHtml(data, refId, fileLinks),
        replyTo: EMAIL_TO,
        etiqueta: 'tramitacion-acuse',
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

    // Último recurso: email de error con TODOS los datos de texto (sin base64),
    // para que el contrato se pueda tramitar a mano aunque Drive haya fallado
    try {
      sendMail({
        to: EMAIL_TO,
        subject: 'ERROR en formulario GNEW - ' + refId,
        textBody: 'Error: ' + error.toString() +
          '\n\nDatos del envío (sin adjuntos):\n' + JSON.stringify(textOnlyData(data), null, 2).slice(0, 50000) +
          '\n\nArchivos que venían adjuntos: ' + (archivos.length > 0 ? archivos.map(function(a) { return sanitizeFileName((a || {}).name); }).join(', ') : 'ninguno'),
        etiqueta: 'tramitacion-error',
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
      const ss = SpreadsheetApp.create('Registro Tramitaciones GNEW');
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
        '<strong>' + soloDrive.length + ' archivo(s) no caben como adjunto (por tamaño o por número de adjuntos) y quedan solo en Drive:</strong> ' +
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
// CAPA DE ENVÍO. sendMail({to, subject, htmlBody|textBody, replyTo, etiqueta, attachments})
// devuelve {ok, via, error, note}. Vía A: Altavoz (si hay ALTAVOZ_API_KEY). Vía B: Gmail
// (respaldo; salvo el acuse a una dirección bloqueada en Altavoz). Nunca lanza: los fallos
// se devuelven en 'error' para que doPost decida.
// ---------------------------------------------------------------------------
function sendMail(msg) {
  const key = getAltavozKey();
  let altavozErr = '';
  if (key) {
    const r = sendViaAltavoz(msg, key);
    if (r.ok) return { ok: true, via: 'altavoz', error: '', note: '' };
    altavozErr = r.error;
    // ACUSE al comercial a una dirección BLOQUEADA en Altavoz (409 destinatario_suprimido:
    // rebote, queja, veto…): NO se reintenta por Gmail, que se saltaría el bloqueo. doPost lo
    // anota como «Acuse al comercial: …» y el contrato sigue siendo success. El aviso al
    // buzón, el aviso de texto y el correo de error SÍ caen a Gmail: un buzón de tramitación
    // nunca se queda sin aviso.
    if (msg.etiqueta === 'tramitacion-acuse' && r.status === 409 && r.codigo === 'destinatario_suprimido') {
      return { ok: false, via: '', error: 'Altavoz: dirección bloqueada (' + altavozErr + ')', note: '' };
    }
  }
  const g = sendViaGmail(msg);
  const note = key
    ? 'vía Gmail (respaldo) porque Altavoz: ' + altavozErr
    : 'vía Gmail (falta ALTAVOZ_API_KEY)';
  if (g.ok) return { ok: true, via: 'gmail', error: '', note: note };
  return { ok: false, via: '', error: (altavozErr ? 'Altavoz: ' + altavozErr + ' | ' : '') + 'Gmail: ' + g.error, note: '' };
}

// Clave de Altavoz, por este orden: 1) Propiedades del script `ALTAVOZ_API_KEY`;
// 2) fichero privado CONFIG_FILE_NAME dentro de FOLDER_ID (solo lo ve la cuenta
// propietaria; NO compartirlo) con {"ALTAVOZ_API_KEY": "av_…"}, cacheado 1h.
// Sin clave por ninguna vía → respaldo Gmail.
const CONFIG_FILE_NAME = 'config-formulario.json';
var altavozKeyCache = null;
function getAltavozKey() {
  if (altavozKeyCache !== null) return altavozKeyCache;
  let key = '';
  try {
    key = String(PropertiesService.getScriptProperties().getProperty('ALTAVOZ_API_KEY') || '').trim();
  } catch (e) {}
  if (!key) {
    try {
      const cache = CacheService.getScriptCache();
      const cached = cache.get('altavoz_key');
      if (cached) {
        key = cached;
      } else {
        const files = DriveApp.getFolderById(FOLDER_ID).getFilesByName(CONFIG_FILE_NAME);
        if (files.hasNext()) {
          const cfg = JSON.parse(files.next().getBlob().getDataAsString('UTF-8') || '{}');
          key = String(cfg.ALTAVOZ_API_KEY || '').trim();
          if (key) cache.put('altavoz_key', key, 3600);
        }
      }
    } catch (e) {}
  }
  altavozKeyCache = key;
  return key;
}

// Cuerpo de la API de avisos de Altavoz (POST ALTAVOZ_URL, JSON). El remitente lo pone
// Altavoz (el de la marca): no se manda. Campos: marca, para (UN email), asunto (1-200,
// una línea) y html o texto; y SOLO si los hay: responder_a (UN email), etiqueta y adjuntos
// [{nombre, contenido en base64 estricto}] (el contrato admite como mucho 10, extensiones
// pdf/jpg/jpeg/png/doc/docx y 3.000.000 bytes reales entre todos: doPost ya lo respeta con
// ATTACH_MAX_COUNT y ATTACH_BUDGET_RAW; si algo no cumpliera, Altavoz respondería 422 y el
// aviso saldría por Gmail).
function buildAltavozBody(msg) {
  const body = { marca: ALTAVOZ_MARCA, para: msg.to, asunto: msg.subject };
  if (msg.htmlBody) body.html = msg.htmlBody;
  else body.texto = msg.textBody || '';
  if (msg.replyTo) body.responder_a = msg.replyTo;
  if (msg.etiqueta) body.etiqueta = msg.etiqueta;
  if (msg.attachments && msg.attachments.length > 0) {
    body.adjuntos = msg.attachments.map(function (b) {
      return { nombre: b.getName(), contenido: Utilities.base64Encode(b.getBytes()) };
    });
  }
  return body;
}

// Una llamada a Altavoz con la clave en Authorization: Bearer. Devuelve {code, text}.
// LANZA si no hay red o falta el permiso de UrlFetchApp: sendViaAltavoz lo captura y
// diagnosticoAltavoz lo enseña tal cual.
function postAltavoz(msg, key) {
  const res = UrlFetchApp.fetch(ALTAVOZ_URL, {
    method: 'post',
    contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + key },
    payload: JSON.stringify(buildAltavozBody(msg)),
    muteHttpExceptions: true
  });
  return { code: res.getResponseCode(), text: String(res.getContentText() || '') };
}

// Un 2xx = Amazon lo aceptó. Cualquier otro código = NO salió (409 modo_prueba o
// destinatario_suprimido, 422 datos que no valen, 502/503 Amazon, 413 de Vercel si la
// petición pasa de ~4,5 MB...): se devuelve el motivo para anotarlo ('error', más el
// 'status' HTTP y el 'codigo' de Altavoz por si sendMail necesita decidir) y caer a Gmail.
// Nunca lanza.
function sendViaAltavoz(msg, key) {
  try {
    const r = postAltavoz(msg, key);
    if (r.code >= 200 && r.code < 300) return { ok: true, error: '' };
    const det = leerErrorAltavoz(r.text);
    return { ok: false, error: altavozError(r.code, r.text), status: r.code, codigo: det ? det.codigo : '' };
  } catch (e) {
    return { ok: false, error: e.toString().slice(0, 200) };
  }
}

// El JSON de error de Altavoz ({error, codigo}) como {codigo, error}, o null si el cuerpo no
// es ese JSON (p. ej. la página HTML de un 413 de Vercel).
function leerErrorAltavoz(texto) {
  try {
    const j = JSON.parse(String(texto || ''));
    if (j && typeof j === 'object') return { codigo: j.codigo ? String(j.codigo) : '', error: j.error ? String(j.error) : '' };
  } catch (parseErr) {}
  return null;
}

// 'HTTP <código> <codigo> <error>' con el JSON de error de Altavoz. Si el cuerpo no es JSON o
// no trae esos campos: sus primeros 200 caracteres, sin etiquetas HTML y en una sola línea.
function altavozError(code, texto) {
  const j = leerErrorAltavoz(texto);
  let detalle = j ? [j.codigo, j.error].filter(Boolean).join(' ') : '';
  if (!detalle) detalle = String(texto || '').replace(/<(style|script)[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]*>/g, ' ');
  return ('HTTP ' + code + ' ' + detalle.replace(/\s+/g, ' ').trim().slice(0, 200)).trim();
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

// Diagnóstico manual (ejecutar desde el editor): dice si el script encuentra la clave de
// Altavoz (solo sus 6 primeros caracteres) y manda por Altavoz un aviso de PRUEBA de solo
// texto, con un PNG de 1×1 de adjunto y responder_a = el buzón receptor, a un alias de
// Victor. Escribe en el registro el código HTTP y la respuesta de Altavoz. Sirve también
// para que Google pida el permiso de UrlFetchApp la primera vez: si sale «You do not have
// permission to call UrlFetchApp.fetch», revocar el acceso del proyecto en
// myaccount.google.com/connections y volver a ejecutar para que Google pida TODOS los
// permisos. Con el «modo prueba» de Altavoz encendido responde 409 modo_prueba: es lo
// esperado (los avisos del formulario saldrían entonces por Gmail).
const PNG_1X1_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGPgzvP/DwADGAHI26TGtQAAAABJRU5ErkJggg==';
function diagnosticoAltavoz() {
  const key = getAltavozKey();
  Logger.log('Clave Altavoz: ' + (key ? 'ENCONTRADA (' + key.slice(0, 6) + '…)' : 'NO ENCONTRADA (pon ALTAVOZ_API_KEY en Propiedades del script o en config-formulario.json)'));
  if (!key) return;
  try {
    const r = postAltavoz({
      to: 'victor.molins.10+formulario@gmail.com',
      subject: 'Prueba del formulario ' + ALTAVOZ_MARCA + ' por Altavoz',
      textBody: 'Prueba de diagnosticoAltavoz() del formulario ' + ALTAVOZ_MARCA + '. Si lees esto, el script llega a Altavoz, la clave vale y Altavoz acepta adjuntos (un PNG de 1x1) y responder_a (' + EMAIL_TO + ').',
      replyTo: EMAIL_TO,
      attachments: [Utilities.newBlob(Utilities.base64Decode(PNG_1X1_BASE64), 'image/png', 'prueba.png')]
    }, key);
    Logger.log('Altavoz HTTP ' + r.code + ' ' + r.text.slice(0, 300));
  } catch (e) {
    Logger.log('Altavoz ERROR: ' + e);
  }
}
