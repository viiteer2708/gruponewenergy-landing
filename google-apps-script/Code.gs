/**
 * GRUPO NEW ENERGY - Backend para formulario de tramitación
 *
 * SETUP:
 * 1. Ve a https://script.google.com y crea un nuevo proyecto
 * 2. Pega este código en Code.gs
 * 3. Crea una carpeta en Google Drive llamada "Contratos Tramitados"
 * 4. Copia el ID de esa carpeta (la parte de la URL después de /folders/)
 * 5. Pega ese ID abajo en FOLDER_ID
 * 6. Crea una Google Sheet llamada "Registro Contratos" y copia su ID
 * 7. Pega ese ID abajo en SHEET_ID
 * 8. Haz clic en "Implementar" > "Nueva implementación"
 * 9. Tipo: "Aplicación web"
 * 10. Ejecutar como: "Yo" (tu cuenta)
 * 11. Acceso: "Cualquier persona"
 * 12. Copia la URL generada y pégala en index.html (variable SCRIPT_URL)
 */

const EMAIL_TO = 'escaneos@gruponew.energy';
const FOLDER_ID = '1UF1OLd9E0GOpnA721GOq4bLyFPC5S4Jc';
const SHEET_ID = 'PEGA_AQUI_EL_ID_DE_TU_GOOGLE_SHEET';

function doPost(e) {
  const refId = generateRefId();
  let data;
  let folderUrl = '';
  let emailSent = false;
  let sheetLogged = false;
  let driveOk = false;
  let errorMsg = '';

  try {
    data = JSON.parse(e.postData.contents);

    // 1. GOOGLE SHEETS - Registrar PRIMERO (es lo más rápido y fiable)
    try {
      logToSheet(data, refId);
      sheetLogged = true;
    } catch (sheetErr) {
      errorMsg += 'Sheet: ' + sheetErr.toString() + '; ';
    }

    // 2. GOOGLE DRIVE - Guardar archivos
    let fileLinks = [];
    try {
      const parentFolder = DriveApp.getFolderById(FOLDER_ID);
      const timestamp = Utilities.formatDate(new Date(), 'Europe/Madrid', 'yyyy-MM-dd HH:mm');
      const folderName = refId + ' - ' + (data.titular || 'Sin titular') + ' - ' + (data.compania || '') + ' - ' + timestamp;
      const folder = parentFolder.createFolder(folderName);
      folderUrl = folder.getUrl();

      if (data.archivos && data.archivos.length > 0) {
        data.archivos.forEach(function(archivo) {
          const blob = Utilities.newBlob(
            Utilities.base64Decode(archivo.data),
            archivo.type,
            archivo.name
          );
          const file = folder.createFile(blob);
          file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
          fileLinks.push({
            name: archivo.name,
            size: archivo.size,
            url: file.getUrl()
          });
        });
      }

      if (data.firma) {
        const sigBlob = Utilities.newBlob(
          Utilities.base64Decode(data.firma.split(',')[1]),
          'image/png',
          'firma.png'
        );
        const sigFile = folder.createFile(sigBlob);
        fileLinks.push({
          name: 'firma.png',
          size: '—',
          url: sigFile.getUrl()
        });
      }

      driveOk = true;
    } catch (driveErr) {
      errorMsg += 'Drive: ' + driveErr.toString() + '; ';
    }

    // 3. EMAIL - Enviar notificación
    try {
      const emailHtml = buildEmailHtml(data, fileLinks, folderUrl, refId);
      GmailApp.sendEmail(EMAIL_TO,
        refId + ' - Nuevo Contrato - ' + (data.titular || 'Sin titular') + ' - ' + (data.compania || ''),
        '',
        {
          htmlBody: emailHtml,
          name: 'Grupo New Energy - Tramitaciones',
          replyTo: data.email_comercial || ''
        }
      );
      emailSent = true;
    } catch (emailErr) {
      errorMsg += 'Email: ' + emailErr.toString() + '; ';
    }

    // 4. Actualizar estado en Sheet
    if (sheetLogged) {
      try {
        updateSheetStatus(refId, driveOk, emailSent, folderUrl);
      } catch (updateErr) {}
    }

    // Si al menos Sheet O Drive funcionaron, consideramos éxito
    if (sheetLogged || driveOk) {
      return ContentService
        .createTextOutput(JSON.stringify({
          success: true,
          refId: refId,
          emailSent: emailSent,
          driveOk: driveOk,
          sheetLogged: sheetLogged
        }))
        .setMimeType(ContentService.MimeType.JSON);
    } else {
      throw new Error('Ningún sistema de respaldo funcionó: ' + errorMsg);
    }

  } catch (error) {
    // Último intento: enviar email de error
    try {
      GmailApp.sendEmail(EMAIL_TO,
        'ERROR en formulario - ' + refId,
        'Error: ' + error.toString() + '\n\nDatos recibidos: ' + (e.postData ? e.postData.contents.substring(0, 500) : 'sin datos')
      );
    } catch (lastErr) {}

    return ContentService
      .createTextOutput(JSON.stringify({ success: false, error: error.toString(), refId: refId }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}

function generateRefId() {
  const now = new Date();
  const date = Utilities.formatDate(now, 'Europe/Madrid', 'yyyyMMdd');
  const rand = Math.random().toString(36).substring(2, 6).toUpperCase();
  return 'GNE-' + date + '-' + rand;
}

function logToSheet(data, refId) {
  const ss = SpreadsheetApp.openById(SHEET_ID);
  let sheet = ss.getSheetByName('Contratos');
  if (!sheet) {
    sheet = ss.insertSheet('Contratos');
    sheet.appendRow([
      'Ref', 'Fecha', 'Comercial', 'Email Comercial', 'Compañía', 'CUPS',
      'Oferta', 'Tarifa', 'Potencias', 'Titular', 'CIF/NIF',
      'Nombre Firmante', 'DNI Firmante', 'Dir. Suministro', 'CP',
      'Población', 'Provincia', 'Móvil', 'Email Cliente',
      'Cuenta Bancaria', 'Cambio Titular', 'Nuevo Titular',
      'Observaciones', 'Nº Archivos', 'Drive OK', 'Email OK', 'Carpeta Drive'
    ]);
    sheet.getRange(1, 1, 1, 27).setFontWeight('bold');
  }

  const potencias = formatPotencias(data);
  const timestamp = Utilities.formatDate(new Date(), 'Europe/Madrid', 'dd/MM/yyyy HH:mm:ss');

  sheet.appendRow([
    refId, timestamp, data.quien_eres, data.email_comercial, data.compania,
    data.cups, data.oferta, data.tarifa, potencias, data.titular,
    data.cif_nif, data.nombre_firmante, data.dni_firmante,
    data.dir_suministro, data.codigo_postal, data.poblacion,
    data.provincia, data.movil, data.email_cliente,
    data.cuenta_bancaria, data.cambio_titular, data.nuevo_titular,
    data.observaciones, data.archivos ? data.archivos.length : 0,
    'Pendiente', 'Pendiente', ''
  ]);
}

function updateSheetStatus(refId, driveOk, emailSent, folderUrl) {
  const ss = SpreadsheetApp.openById(SHEET_ID);
  const sheet = ss.getSheetByName('Contratos');
  if (!sheet) return;

  const data = sheet.getDataRange().getValues();
  for (let i = data.length - 1; i >= 1; i--) {
    if (data[i][0] === refId) {
      sheet.getRange(i + 1, 25).setValue(driveOk ? 'OK' : 'ERROR');
      sheet.getRange(i + 1, 26).setValue(emailSent ? 'OK' : 'ERROR');
      sheet.getRange(i + 1, 27).setValue(folderUrl);
      break;
    }
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
        '<td style="padding:10px 14px;border:1px solid #e2e8f0;font-size:13px">' + f[1] + '</td>' +
      '</tr>';
    }
  });

  let filesHtml = '';
  if (fileLinks.length > 0) {
    filesHtml = '<h3 style="color:#094D38;margin:24px 0 12px;font-size:15px">Documentación adjunta</h3><ul style="list-style:none;padding:0">';
    fileLinks.forEach(function(f) {
      filesHtml += '<li style="margin:8px 0;padding:10px 14px;background:#f8fffe;border:1px solid #e2e8f0;border-radius:8px;font-size:13px">' +
        '<a href="' + f.url + '" style="color:#0B6E4F;font-weight:600;text-decoration:none">' + f.name + '</a>' +
        '<span style="color:#6B7280;margin-left:8px">' + f.size + '</span>' +
      '</li>';
    });
    filesHtml += '</ul>';
    filesHtml += '<p style="margin-top:12px"><a href="' + folderUrl + '" style="color:#0B6E4F;font-weight:600">Abrir carpeta en Google Drive</a></p>';
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
