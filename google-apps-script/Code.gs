/**
 * GRUPO NEW ENERGY - Backend para formulario de tramitación
 *
 * SETUP:
 * 1. Ve a https://script.google.com y crea un nuevo proyecto
 * 2. Pega este código en Code.gs
 * 3. Crea una carpeta en Google Drive llamada "Contratos Tramitados"
 * 4. Copia el ID de esa carpeta (la parte de la URL después de /folders/)
 * 5. Pega ese ID abajo en FOLDER_ID
 * 6. Haz clic en "Implementar" > "Nueva implementación"
 * 7. Tipo: "Aplicación web"
 * 8. Ejecutar como: "Yo" (tu cuenta)
 * 9. Acceso: "Cualquier persona"
 * 10. Copia la URL generada y pégala en index.html (variable SCRIPT_URL)
 */

const EMAIL_TO = 'escaneos@gruponew.energy';
const FOLDER_ID = '1UF1OLd9E0GOpnA721GOq4bLyFPC5S4Jc';

function doPost(e) {
  try {
    const data = JSON.parse(e.postData.contents);

    // Crear subcarpeta con nombre del titular y fecha
    const parentFolder = DriveApp.getFolderById(FOLDER_ID);
    const timestamp = Utilities.formatDate(new Date(), 'Europe/Madrid', 'yyyy-MM-dd HH:mm');
    const folderName = `${data.titular || 'Sin titular'} - ${data.compania || ''} - ${timestamp}`;
    const folder = parentFolder.createFolder(folderName);

    // Guardar archivos en Drive
    const fileLinks = [];
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

    // Guardar firma si existe
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

    // Construir email HTML
    const emailHtml = buildEmailHtml(data, fileLinks, folder.getUrl());

    // Enviar email
    GmailApp.sendEmail(EMAIL_TO,
      `Nuevo Contrato - ${data.titular || 'Sin titular'} - ${data.compania || ''}`,
      '',
      {
        htmlBody: emailHtml,
        name: 'Grupo New Energy - Tramitaciones',
        replyTo: data.email_comercial || ''
      }
    );

    // Respuesta exitosa
    return ContentService
      .createTextOutput(JSON.stringify({ success: true }))
      .setMimeType(ContentService.MimeType.JSON);

  } catch (error) {
    return ContentService
      .createTextOutput(JSON.stringify({ success: false, error: error.toString() }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}

function buildEmailHtml(data, fileLinks, folderUrl) {
  const fields = [
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
      rows += `<tr>
        <td style="padding:10px 14px;font-weight:600;color:#094D38;background:#f0faf6;border:1px solid #e2e8f0;width:200px;font-size:13px">${f[0]}</td>
        <td style="padding:10px 14px;border:1px solid #e2e8f0;font-size:13px">${f[1]}</td>
      </tr>`;
    }
  });

  let filesHtml = '';
  if (fileLinks.length > 0) {
    filesHtml = '<h3 style="color:#094D38;margin:24px 0 12px;font-size:15px">Documentación adjunta</h3><ul style="list-style:none;padding:0">';
    fileLinks.forEach(function(f) {
      filesHtml += `<li style="margin:8px 0;padding:10px 14px;background:#f8fffe;border:1px solid #e2e8f0;border-radius:8px;font-size:13px">
        <a href="${f.url}" style="color:#0B6E4F;font-weight:600;text-decoration:none">${f.name}</a>
        <span style="color:#6B7280;margin-left:8px">${f.size}</span>
      </li>`;
    });
    filesHtml += '</ul>';
    filesHtml += `<p style="margin-top:12px"><a href="${folderUrl}" style="color:#0B6E4F;font-weight:600">Abrir carpeta en Google Drive</a></p>`;
  }

  return `
    <div style="font-family:Arial,sans-serif;max-width:650px;margin:0 auto">
      <div style="background:#094D38;color:#fff;padding:20px 24px;border-radius:10px 10px 0 0">
        <h2 style="margin:0;font-size:18px">Nuevo Contrato para Tramitar</h2>
        <p style="margin:6px 0 0;opacity:.8;font-size:13px">${Utilities.formatDate(new Date(), 'Europe/Madrid', "dd/MM/yyyy 'a las' HH:mm")}</p>
      </div>
      <div style="background:#fff;padding:24px;border:1px solid #e2e8f0;border-top:none;border-radius:0 0 10px 10px">
        <table style="width:100%;border-collapse:collapse">${rows}</table>
        ${filesHtml}
      </div>
    </div>
  `;
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
