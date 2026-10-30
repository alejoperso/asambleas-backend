
app.post('/api/documents', async (req, res) => {
  try {
    const { assemblyId, titulo, archivoBase64 } = req.body;
    const targetAssembly = assemblyId || 1;
    try {
      await db.query(`INSERT INTO documentos (assembly_id, titulo, archivo_url) VALUES (?, ?, ?)`, [targetAssembly, titulo, archivoBase64]);
    } catch (e) {
      memoryDocuments.push({ id: Date.now(), assemblyId: targetAssembly, titulo, archivo_url: archivoBase64, created_at: new Date() });
    }
    io.to(`assembly_${targetAssembly}`).emit('documents:updated');
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.delete('/api/documents/:id', async (req, res) => {
  try {
    const { id } = req.params;
    let targetAssembly = 1;

    try {
      const [doc] = await db.query(`SELECT assembly_id FROM documentos WHERE id = ?`, [id]);
      if (doc.length > 0) targetAssembly = doc[0].assembly_id;
      await db.query(`DELETE FROM documentos WHERE id = ?`, [id]);
    } catch (e) {
      const idx = memoryDocuments.findIndex(d => d.id == id);
      if (idx !== -1) {
        targetAssembly = memoryDocuments[idx].assemblyId || 1;
        memoryDocuments.splice(idx, 1);
      }
    }

    io.to(`assembly_${targetAssembly}`).emit('documents:updated');
    res.json({ ok: true, message: 'Documento eliminado exitosamente.' });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get('/api/questions/:assemblyId', async (req, res) => {
  try {
    const { assemblyId } = req.params;
    const [preguntas] = await db.query(`SELECT * FROM preguntas WHERE assembly_id = ? ORDER BY id DESC`, [assemblyId]);
    for (let p of preguntas) {
      const [opciones] = await db.query(`SELECT * FROM opciones_pregunta WHERE pregunta_id = ? ORDER BY orden ASC`, [p.id]);
      p.opciones = opciones;
      if (p.estado === 'cerrada' || p.estado === 'activa') {
        p.resultados = await calculateWeightedResults(assemblyId, p.id);
      }
    }
    res.json({ ok: true, preguntas });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get('/api/questions/detail/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const [preguntas] = await db.query(`SELECT * FROM preguntas WHERE id = ?`, [id]);
    if (preguntas.length === 0) return res.status(404).json({ ok: false, error: 'Pregunta no encontrada' });
    const [opciones] = await db.query(`SELECT * FROM opciones_pregunta WHERE pregunta_id = ? ORDER BY orden ASC`, [id]);
    preguntas[0].opciones = opciones;
    res.json({ ok: true, pregunta: preguntas[0] });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/api/questions', async (req, res) => {
  try {
    const { assemblyId, textoPregunta, duracionSegundos, opciones } = req.body;
    const targetAssembly = parseInt(assemblyId) || 1;
    const [result] = await db.query(
      `INSERT INTO preguntas (assembly_id, texto_pregunta, duracion_segundos, estado) VALUES (?, ?, ?, 'borrador')`,
      [targetAssembly, textoPregunta, parseInt(duracionSegundos) || 60]
    );
    const preguntaId = result.insertId;
    for (let i = 0; i < opciones.length; i++) {
      await db.query(`INSERT INTO opciones_pregunta (pregunta_id, texto_opcion, orden) VALUES (?, ?, ?)`, [preguntaId, opciones[i], i + 1]);
    }
    assemblyDraftPreview.delete(targetAssembly);
    io.to(`assembly_${targetAssembly}`).emit('question:draft_preview', { isTyping: false });
    io.to(`assembly_${targetAssembly}`).emit('questions:updated');
    res.json({ ok: true, preguntaId });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.put('/api/questions/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { textoPregunta, duracionSegundos, opciones, assemblyId } = req.body;
    const targetAssembly = parseInt(assemblyId) || 1;
    await db.query(`UPDATE preguntas SET texto_pregunta = ?, duracion_segundos = ? WHERE id = ?`, [textoPregunta, parseInt(duracionSegundos) || 60, id]);
    
    if (opciones && opciones.length >= 2) {
      await db.query(`DELETE FROM opciones_pregunta WHERE pregunta_id = ?`, [id]);
      for (let i = 0; i < opciones.length; i++) {
        await db.query(`INSERT INTO opciones_pregunta (pregunta_id, texto_opcion, orden) VALUES (?, ?, ?)`, [id, opciones[i], i + 1]);
      }
    }
    assemblyDraftPreview.delete(targetAssembly);
    io.to(`assembly_${targetAssembly}`).emit('question:draft_preview', { isTyping: false });
    io.to(`assembly_${targetAssembly}`).emit('questions:updated');
    res.json({ ok: true, message: 'Pregunta actualizada exitosamente.' });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.delete('/api/questions/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { assemblyId } = req.query;

    await db.query(`DELETE FROM votos WHERE pregunta_id = ?`, [id]);
    await db.query(`DELETE FROM opciones_pregunta WHERE pregunta_id = ?`, [id]);
    await db.query(`DELETE FROM preguntas WHERE id = ?`, [id]);

    const targetAssembly = parseInt(assemblyId) || 1;
    io.to(`assembly_${targetAssembly}`).emit('questions:updated');
    res.json({ ok: true, message: 'Pregunta y sus votos fueron eliminados correctamente.' });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get('/api/powers/:assemblyId', async (req, res) => {
  try {
    const { assemblyId } = req.params;
    const [poderes] = await db.query(
      `SELECT p.id, p.estado, p.documento_url, p.observaciones, p.created_at,
              u_ot.id AS otorgante_num_id, u_ot.identificador_unico AS otorgante_id, u_ot.nombre_completo AS otorgante_nombre, u_ot.coeficiente AS otorgante_coef,
              u_ap.id AS apoderado_num_id, u_ap.identificador_unico AS apoderado_id, u_ap.nombre_completo AS apoderado_nombre
       FROM poderes p
       JOIN usuarios u_ot ON p.otorgante_id = u_ot.id
       JOIN usuarios u_ap ON p.apoderado_id = u_ap.id
       WHERE p.assembly_id = ?
       ORDER BY p.created_at DESC`,
      [assemblyId]
    );

    for (let pod of poderes) {
      pod.apoderado_coef_efectivo = await getUserEffectiveCoefficient(pod.apoderado_num_id, assemblyId);
    }

    res.json({ ok: true, poderes });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get('/api/powers/:id/quick-action', async (req, res) => {
  try {
    const { id } = req.params;
    const { status, token } = req.query;

    if (!id || !status || !token) {
      return res.status(400).send(renderResponseHTML('Error de Solicitud', 'Parámetros incompletos en el enlace.', false));
    }

    const expectedToken = generatePowerActionToken(id, status);
    if (token !== expectedToken) {
      return res.status(403).send(renderResponseHTML('Enlace Inválido', 'El token de seguridad no es válido o ha expirado.', false));
    }

    const [podRows] = await db.query(
      `SELECT p.id, p.assembly_id, p.estado, u_ot.nombre_completo AS otorgante, u_ap.nombre_completo AS apoderado 
       FROM poderes p
       JOIN usuarios u_ot ON p.otorgante_id = u_ot.id
       JOIN usuarios u_ap ON p.apoderado_id = u_ap.id
       WHERE p.id = ?`,
      [id]
    );

    if (podRows.length === 0) {
      return res.status(404).send(renderResponseHTML('No Encontrado', 'El poder especificado no existe.', false));
    }

    const poder = podRows[0];
    const nuevoEstado = status === 'autorizado' ? 'autorizado' : 'rechazado';
    const observacion = `Procesado mediante acción directa desde correo electrónico el ${new Date().toLocaleString('es-CO', { timeZone: 'America/Bogota' })}`;

    await db.query(`UPDATE poderes SET estado = ?, observaciones = ? WHERE id = ?`, [nuevoEstado, observacion, id]);

    await updateAndBroadcastQuorum(poder.assembly_id);
    io.to(`assembly_${poder.assembly_id}`).emit('powers:updated');

    const colorHeader = nuevoEstado === 'autorizado' ? '#10b981' : '#ef4444';
    const tituloResultado = nuevoEstado === 'autorizado' ? 'Poder Aprobado y Autorizado' : 'Poder Rechazado';
    const mensajeDetalle = `El poder otorgado por <strong>${poder.otorgante}</strong> a favor de <strong>${poder.apoderado}</strong> ha sido marcado como <strong>${nuevoEstado.toUpperCase()}</strong> correctamente.`;

    return res.send(renderResponseHTML(tituloResultado, mensajeDetalle, true, colorHeader));

  } catch (err) {
    console.error('Error en quick-action poder:', err);
    return res.status(500).send(renderResponseHTML('Error Interno', 'No se pudo procesar la solicitud.', false));
  }
});

app.put('/api/powers/:id/status', async (req, res) => {
  try {
    const { id } = req.params;
    const { estado, observaciones } = req.body;
    const [p] = await db.query(`SELECT assembly_id FROM poderes WHERE id = ?`, [id]);
    if (p.length === 0) return res.status(404).json({ ok: false, error: 'Poder no encontrado' });

    await db.query(`UPDATE poderes SET estado = ?, observaciones = ? WHERE id = ?`, [estado, observaciones || '', id]);

    const targetAssembly = p[0].assembly_id;
    await updateAndBroadcastQuorum(targetAssembly);
    io.to(`assembly_${targetAssembly}`).emit('powers:updated');
    res.json({ ok: true, message: `Poder ${estado} correctamente.` });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.delete('/api/powers/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const [p] = await db.query(`SELECT assembly_id FROM poderes WHERE id = ?`, [id]);
    if (p.length === 0) return res.status(404).json({ ok: false, error: 'Poder no encontrado' });

    const targetAssembly = p[0].assembly_id;
    await db.query(`DELETE FROM poderes WHERE id = ?`, [id]);

    await updateAndBroadcastQuorum(targetAssembly);
    io.to(`assembly_${targetAssembly}`).emit('powers:updated');
    res.json({ ok: true, message: 'Poder eliminado correctamente.' });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/api/powers/manual', async (req, res) => {
  try {
    const { assemblyId, otorganteId, apoderadoIdentificador, apoderadoNombre } = req.body;
    const targetAssembly = parseInt(assemblyId) || 1;
    const cleanOtorgante = (otorganteId || '').toString().trim().toUpperCase();
    const cleanApoderado = (apoderadoIdentificador || '').toString().trim().toUpperCase();

    if (!cleanOtorgante || !cleanApoderado) {
      return res.status(400).json({ ok: false, error: 'Identificador del otorgante y del apoderado son requeridos.' });
    }

    let [otorganteRows] = await db.query(
      `SELECT id FROM usuarios WHERE assembly_id = ? AND (UPPER(identificador_unico) = ? OR UPPER(unidad) = ? OR id = ?)`,
      [targetAssembly, cleanOtorgante, cleanOtorgante, parseInt(cleanOtorgante) || 0]
    );

    if (otorganteRows.length === 0) {
      return res.status(404).json({ ok: false, error: `El inmueble/otorgante [${cleanOtorgante}] no fue encontrado en la base de datos.` });
    }

    const otorganteNumId = otorganteRows[0].id;

    let [apoderadoRows] = await db.query(
      `SELECT id FROM usuarios WHERE assembly_id = ? AND (UPPER(identificador_unico) = ? OR UPPER(unidad) = ? OR id = ?)`,
      [targetAssembly, cleanApoderado, cleanApoderado, parseInt(cleanApoderado) || 0]
    );

    let apoderadoNumId;
    if (apoderadoRows.length === 0) {
      const [ins] = await db.query(
        `INSERT INTO usuarios (assembly_id, identificador_unico, nombre_completo, unidad, coeficiente, rol)
         VALUES (?, ?, ?, 'Apoderado Externo', 0.00000, 'asistente')`,
        [targetAssembly, cleanApoderado, apoderadoNombre || cleanApoderado]
      );
      apoderadoNumId = ins.insertId;
    } else {
      apoderadoNumId = apoderadoRows[0].id;
    }

    if (otorganteNumId === apoderadoNumId) {
      return res.status(400).json({ ok: false, error: 'El otorgante y el apoderado no pueden ser la misma persona.' });
    }

    await db.query(
      `INSERT INTO poderes (assembly_id, otorgante_id, apoderado_id, documento_url, estado, observaciones)
       VALUES (?, ?, ?, 'ASIGNACIÓN DIRECTA ADMIN', 'autorizado', 'Asignado manualmente por Representante/Admin')
       ON DUPLICATE KEY UPDATE apoderado_id = VALUES(apoderado_id), estado = 'autorizado'`,
      [targetAssembly, otorganteNumId, apoderadoNumId]
    );

    await updateAndBroadcastQuorum(targetAssembly);
    io.to(`assembly_${targetAssembly}`).emit('powers:updated');
    res.json({ ok: true, message: 'Poder asignado y autorizado correctamente.' });
  } catch (err) {
    console.error('Error en asignar poder manual:', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/api/powers', async (req, res) => {
  try {
    const { assemblyId, otorganteUnico, apoderadoUnico, documentoUrl } = req.body;
    const targetAssembly = parseInt(assemblyId) || 1;
    const cleanOtorgante = (otorganteUnico || '').toString().trim().toUpperCase();
    const cleanApoderado = (apoderadoUnico || '').toString().trim().toUpperCase();

    const [otorgantes] = await db.query(
      `SELECT id, nombre_completo, unidad FROM usuarios WHERE assembly_id = ? AND UPPER(identificador_unico) = ?`,
      [targetAssembly, cleanOtorgante]
    );
    const [apoderados] = await db.query(
      `SELECT id, nombre_completo, unidad FROM usuarios WHERE assembly_id = ? AND UPPER(identificador_unico) = ?`,
      [targetAssembly, cleanApoderado]
    );

    if (otorgantes.length === 0) return res.status(400).json({ ok: false, error: 'El otorgante no existe.' });
    if (apoderados.length === 0) return res.status(400).json({ ok: false, error: 'El apoderado no existe.' });

    const otorganteUser = otorgantes[0];
    const apoderadoUser = apoderados[0];

    const [resultPoder] = await db.query(
      `INSERT INTO poderes (assembly_id, otorgante_id, apoderado_id, documento_url, estado) VALUES (?, ?, ?, ?, 'pendiente')`,
      [targetAssembly, otorganteUser.id, apoderadoUser.id, documentoUrl]
    );

    const powerId = resultPoder.insertId;
    io.to(`assembly_${targetAssembly}`).emit('powers:updated');

    try {
      const [reps] = await db.query(
        `SELECT email, nombre_completo FROM usuarios 
         WHERE assembly_id = ? AND rol IN ('representante_legal', 'administrador') AND email IS NOT NULL AND email != ''`,
        [targetAssembly]
      );

      const [asamblea] = await db.query(`SELECT nombre_copropiedad FROM asambleas WHERE id = ?`, [targetAssembly]);
      const nombreCopropiedad = asamblea.length > 0 ? asamblea[0].nombre_copropiedad : 'Asamblea Virtual';

      if (reps.length > 0) {
        const emailsDestino = reps.map(r => r.email);
        const fromSender = process.env.RESEND_FROM_EMAIL || 'contacto@ajaudiovisual.com';
        const serverBaseUrl = process.env.SERVER_URL || `${req.protocol}://${req.get('host')}`;

        const tokenApprove = generatePowerActionToken(powerId, 'autorizado');
        const tokenReject = generatePowerActionToken(powerId, 'rechazado');

        const approveLink = `${serverBaseUrl}/api/powers/${powerId}/quick-action?status=autorizado&token=${tokenApprove}`;
        const rejectLink = `${serverBaseUrl}/api/powers/${powerId}/quick-action?status=rechazado&token=${tokenReject}`;

        let attachments = [];
        if (documentoUrl && documentoUrl.startsWith('data:')) {
          const matches = documentoUrl.match(/^data:(.+);base64,(.+)$/);
          if (matches) {
            const mimeType = matches[1];
            const base64Content = matches[2];
            let ext = 'pdf';
            if (mimeType.includes('png')) ext = 'png';
            else if (mimeType.includes('jpeg') || mimeType.includes('jpg')) ext = 'jpg';

            attachments.push({
              filename: `Poder_${cleanOtorgante}_a_${cleanApoderado}.${ext}`,
              content: Buffer.from(base64Content, 'base64')
            });
          }
        }

        await resend.emails.send({
          from: `${nombreCopropiedad} <${fromSender}>`,
          to: emailsDestino,
          subject: `🚨 Alerta: Nuevo Poder Pendiente por Autorizar - ${nombreCopropiedad}`,
          text: `Atención Representante Legal, se ha recibido un nuevo poder pendiente por aprobación.\nOtorgante: ${otorganteUser.nombre_completo} (${otorganteUser.unidad})\nApoderado: ${apoderadoUser.nombre_completo} (${apoderadoUser.unidad})\nAprobar: ${approveLink}\nRechazar: ${rejectLink}`,
          html: `
            <div style="font-family: Arial, sans-serif; background-color: #0f172a; color: #f8fafc; padding: 25px; border-radius: 12px; max-width: 600px; margin: auto;">
              <h2 style="color: #f59e0b; text-align: center; margin-bottom: 20px;">⚠️ Nuevo Poder Pendiente de Autorización</h2>
              <p style="font-size: 14px; line-height: 1.6;">Estimado(a) Representante Legal / Administrador,</p>
              <p style="font-size: 14px; line-height: 1.6;">Se ha radicado una solicitud de poder en la plataforma para la copropiedad <strong>${nombreCopropiedad}</strong>.</p>
              
              <div style="background-color: #1e293b; padding: 18px; border-radius: 8px; border-left: 4px solid #f59e0b; margin: 20px 0;">
                <p style="margin: 6px 0; font-size: 14px;"><strong>Otorgante:</strong> ${otorganteUser.nombre_completo} (Unidad: ${otorganteUser.unidad})</p>
                <p style="margin: 6px 0; font-size: 14px;"><strong>Apoderado:</strong> ${apoderadoUser.nombre_completo} (Unidad: ${apoderadoUser.unidad})</p>
                <p style="margin: 6px 0; font-size: 14px;"><strong>Estado:</strong> <span style="color: #f59e0b; font-weight: bold;">PENDIENTE DE REVISIÓN</span></p>
              </div>

              <div style="text-align: center; margin: 25px 0;">
                <a href="${approveLink}" target="_blank" style="background-color: #10b981; color: #ffffff; padding: 12px 24px; border-radius: 8px; font-weight: bold; text-decoration: none; display: inline-block; margin-right: 10px; font-size: 14px;">
                  ✓ APROBAR PODER
                </a>
                <a href="${rejectLink}" target="_blank" style="background-color: #ef4444; color: #ffffff; padding: 12px 24px; border-radius: 8px; font-weight: bold; text-decoration: none; display: inline-block; font-size: 14px;">
                  ✕ RECHAZAR PODER
                </a>
              </div>

              <p style="font-size: 12px; color: #cbd5e1; line-height: 1.6; text-align: center;">
                El documento adjunto se encuentra disponible en este correo. Puede hacer clic en cualquiera de los botones superiores para autorizar o rechazar este poder de manera inmediata.
              </p>

              <p style="font-size: 11px; color: #64748b; text-align: center; margin-top: 30px; border-top: 1px solid #334155; padding-top: 15px;">
                Notificación automática del Sistema de Asambleas Virtuales.
              </p>
            </div>
          `,
          attachments: attachments
        });
      }
    } catch (emailErr) {
      console.error('Error al enviar correo de alerta de poder al representante:', emailErr);
    }

    res.json({ ok: true, message: 'Poder registrado exitosamente y notificación enviada al representante legal.' });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get('/api/users/:assemblyId', async (req, res) => {
  try {
    const { assemblyId } = req.params;
    const { search, all } = req.query;
    let sql = `SELECT id, identificador_unico, nombre_completo, unidad, email, coeficiente, rol FROM usuarios WHERE assembly_id = ?`;
    let params = [assemblyId];

    if (search) {
      sql += ` AND (UPPER(identificador_unico) LIKE ? OR UPPER(nombre_completo) LIKE ? OR UPPER(unidad) LIKE ? OR UPPER(email) LIKE ?)`;
      const term = `%${search.toUpperCase()}%`;
      params.push(term, term, term, term);
    }
    sql += ` ORDER BY unidad ASC`;
    if (all !== 'true') {
      sql += ` LIMIT 50`;
    }
    const [usuarios] = await db.query(sql, params);

    for (let u of usuarios) {
      u.coeficiente_efectivo = await getUserEffectiveCoefficient(u.id, assemblyId);
    }

    res.json({ ok: true, usuarios });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get('/api/reports/assembly/:id/excel', async (req, res) => {
  try {
    const { id } = req.params;
    const [votos] = await db.query(
      `SELECT p.texto_pregunta AS Pregunta, u.identificador_unico AS ID_Votante, u.nombre_completo AS Nombre, u.unidad AS Unidad, o.texto_opcion AS Opcion_Votada, v.coeficiente_aplicado AS Coeficiente_Efectivo, v.created_at AS Fecha_Hora_Voto
       FROM votos v
       JOIN preguntas p ON v.pregunta_id = p.id
       JOIN usuarios u ON v.usuario_id = u.id
       JOIN opciones_pregunta o ON v.opcion_id = o.id
       WHERE v.assembly_id = ?
       ORDER BY p.id ASC, v.created_at ASC`,
      [id]
    );

    let csvContent = "\uFEFFPregunta;ID Votante;Nombre;Unidad;Opción Votada;Coeficiente Aplicado (%);Fecha y Hora\n";
    votos.forEach(v => {
      const coefPct = parseFloat(v.Coeficiente_Efectivo).toFixed(4);
      const fecha = new Date(v.Fecha_Hora_Voto).toLocaleString('es-CO', { timeZone: 'America/Bogota' });
      csvContent += `"${v.Pregunta}";"${v.ID_Votante}";"${v.Nombre}";"${v.Unidad}";"${v.Opcion_Votada}";"${coefPct}%";"${fecha}"\n`;
    });

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename=Reporte_Votacion_Asamblea_${id}.csv`);
    res.status(200).send(csvContent);
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get('/api/reports/assembly/:id/pdf-data', async (req, res) => {
  try {
    const { id } = req.params;
    const [asambleas] = await db.query(`SELECT * FROM asambleas WHERE id = ?`, [id]);
    if (asambleas.length === 0) return res.status(404).json({ ok: false, error: 'Asamblea no encontrada' });

    const [usuarios] = await db.query(
      `SELECT id, identificador_unico, nombre_completo, unidad, coeficiente, email, rol 
       FROM usuarios 
       WHERE assembly_id = ? AND rol = 'asistente' 
       ORDER BY unidad ASC`,
      [id]
    );

    const [preguntas] = await db.query(
      `SELECT * FROM preguntas WHERE assembly_id = ? ORDER BY id DESC`,
      [id]
    );

    for (let p of preguntas) {
      const [opciones] = await db.query(
        `SELECT * FROM opciones_pregunta WHERE pregunta_id = ? ORDER BY orden ASC`,
        [p.id]
      );
      p.opciones = opciones;
    }

    const [votos] = await db.query(
      `SELECT v.id, v.pregunta_id, v.usuario_id, v.opcion_id, o.texto_opcion, v.coeficiente_aplicado, v.created_at
       FROM votos v
       JOIN opciones_pregunta o ON v.opcion_id = o.id
       WHERE v.assembly_id = ?`,
      [id]
    );

    const activeUserIds = new Set();
    for (const [key, session] of activeSessions.entries()) {
      if (parseInt(session.assemblyId) === parseInt(id) && session.userId > 0) {
        activeUserIds.add(session.userId);
      }
    }

    const totalCargados = usuarios.length;
    const totalConectados = activeUserIds.size;
    const totalNoConectados = Math.max(0, totalCargados - totalConectados);

    let primerVotoFecha = null;
    if (votos.length > 0) {
      primerVotoFecha = votos[0].created_at;
    }

    const asambleaData = asambleas[0];
    asambleaData.fecha_evento_final = asambleaData.fecha_evento || asambleaData.hora_inicio || primerVotoFecha || asambleaData.created_at || new Date();

    res.json({
      ok: true,
      asamblea: asambleaData,
      usuarios,
      preguntas,
      votos,
      asistencia: {
        totalCargados,
        totalConectados,
        totalNoConectados
      }
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// GENERADOR DE FIRMAS OFICIALES DEL SDK DE ZOOM
app.post('/api/zoom/signature', async (req, res) => {
  try {
    const { meetingNumber, role } = req.body;
    const sdkKey = (process.env.ZOOM_SDK_KEY || 'dPDveYuySJKLhCdur6gOiQ').trim();
    const sdkSecret = (process.env.ZOOM_SDK_SECRET || 'eunmyWxjZ36p17tn2mTPzLvV2hRXFLwc').trim();

    const cleanMn = parseInt((meetingNumber || '').toString().replace(/\D/g, ''), 10);
    if (!cleanMn || isNaN(cleanMn)) return res.status(400).json({ ok: false, error: 'ID Zoom Inválido.' });

    const requestedRole = parseInt(role || 0, 10) === 1 ? 1 : 0;

    const zoomNow = await getZoomServerUnixTime();
    const iat = zoomNow - 30;
    const exp = iat + 60 * 60 * 2;

    const oHeader = { alg: 'HS256', typ: 'JWT' };
    const oPayload = {
      sdkKey,
      appKey: sdkKey,
      mn: cleanMn,
      role: requestedRole,
      iat,
      exp,
      tokenExp: exp
    };

    const sHeader = toBase64Url(JSON.stringify(oHeader));
    const sPayload = toBase64Url(JSON.stringify(oPayload));
    const dataToSign = `${sHeader}.${sPayload}`;
    const hmac = crypto.createHmac('sha256', sdkSecret).update(dataToSign).digest();
    const signature = toBase64Url(hmac);

    let zakToken = null;
    if (requestedRole === 1) {
      zakToken = await getZoomHostZakToken();
    }

    res.json({ ok: true, signature: `${dataToSign}.${signature}`, sdkKey, zakToken, role: requestedRole });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// CONSULTA DE PARÁMETROS DE ZOOM CON COMPUERTA DE BLOQUEO PARA ASISTENTES
app.get('/api/assemblies/:id/zoom', async (req, res) => {
  try {
    const { id } = req.params;
    const isAdminQuery = req.query.admin === 'true';
    const streamInfo = await getAssemblyZoomStreamInfo(id);

    if (!isAdminQuery && !streamInfo.zoomHabilitado) {
      return res.json({
        ok: true,
        zoom: {
          rawUrl: '',
          meetingId: '',
          passcode: '',
          zoomHabilitado: false
        }
      });
    }

    res.json({ ok: true, zoom: streamInfo });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.put('/api/assemblies/:id/zoom', async (req, res) => {
  try {
    const { id } = req.params;
    const targetAssembly = parseInt(id) || 1;
    const { zoomEmbedUrl, zoomPasscode } = req.body;
    const parsed = parseZoomCredentials(zoomEmbedUrl, zoomPasscode);
    await db.query(`UPDATE asambleas SET zoom_embed_url = ?, zoom_meeting_id = ?, zoom_passcode = ? WHERE id = ?`, [zoomEmbedUrl, parsed.meetingId, parsed.passcode, targetAssembly]);
    const streamData = await getAssemblyZoomStreamInfo(targetAssembly);
    io.to(`assembly_${targetAssembly}`).emit('zoom:updated', { streamInfo: streamData });
    res.json({ ok: true, message: 'Zoom actualizado.', streamInfo: streamData });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// INTERRUPTOR EN ADMIN PARA ABRIR O CERRAR EL ACCESO A LA SALA DE ZOOM A LOS PARTICIPANTES
app.put('/api/assemblies/:id/zoom-gate', async (req, res) => {
  try {
    const { id } = req.params;
    const targetAssembly = parseInt(id) || 1;
    const { habilitado } = req.body;
    const isOpen = !!habilitado;

    assemblyZoomOpen.set(targetAssembly, isOpen);
    try {
      await db.query(`UPDATE asambleas SET zoom_habilitado = ? WHERE id = ?`, [isOpen ? 1 : 0, targetAssembly]);
    } catch (e) {}

    const streamData = await getAssemblyZoomStreamInfo(targetAssembly);
    io.to(`assembly_${targetAssembly}`).emit('zoom:updated', { streamInfo: streamData });

    res.json({
      ok: true,
      zoomHabilitado: isOpen,
      streamInfo: streamData,
      message: isOpen
        ? '🔓 Sala de Zoom HABILITADA: Todos los participantes pueden ver e ingresar a la reunión.'
        : '🔒 Sala de Zoom EN ESPERA: Los participantes no pueden iniciar ni entrar a la reunión hasta que la habilites.'
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get('/', (req, res) => res.json({ status: 'online', version: '3.5.0-media-permissions' }));

// WEBSOCKETS EN TIEMPO REAL
io.on('connection', (socket) => {

  socket.on('auth:join', async ({ assemblyId, identificadorUnico, email, password, isConsoleAdmin, rolConsola, nombreConsola }) => {
    try {
      const targetAssembly = parseInt(assemblyId) || 1;
      const targetId = (identificadorUnico || '').toString().trim().toUpperCase();
      const targetEmail = (email || '').toString().trim().toLowerCase();
      const targetPassword = (password || '').toString().trim();

      let [rows] = await db.query(
        `SELECT id, identificador_unico, nombre_completo, unidad, email, password, coeficiente, rol 
         FROM usuarios 
         WHERE assembly_id = ? AND (LOWER(email) = ? OR UPPER(identificador_unico) = ?)`,
        [targetAssembly, targetEmail || targetId.toLowerCase(), targetId]
      );

      if (rows.length === 0 && (targetEmail || targetId)) {
        const [controlRows] = await db.query(
          `SELECT id, identificador_unico, nombre_completo, unidad, email, password, coeficiente, rol 
           FROM usuarios 
           WHERE (LOWER(email) = ? OR UPPER(identificador_unico) = ?) 
             AND rol IN ('administrador', 'soporte', 'moderador', 'representante_legal')
           ORDER BY id DESC LIMIT 1`,
          [targetEmail || targetId.toLowerCase(), targetId]
        );
        if (controlRows.length > 0) {
          rows = [{
            ...controlRows[0],
            coeficiente: 0.00000
          }];
        }
      }

      if (
        rows.length === 0 &&
        (
          targetId === 'SUPERADMIN' ||
          targetId.startsWith('ADMIN-') ||
          targetId.startsWith('MODERADOR-') ||
          targetId.startsWith('REPRESENTANTE_LEGAL-') ||
          targetEmail === SUPERADMIN_EMAIL.toLowerCase() ||
          isConsoleAdmin
        )
      ) {
        rows = [{
          id: 0,
          identificador_unico: targetId || 'SUPERADMIN',
          nombre_completo: nombreConsola || 'Consola de Control',
          unidad: 'CONTROL',
          coeficiente: 0.00000,
          rol: rolConsola || 'superadmin'
        }];
      }

      if (rows.length === 0 && targetId.startsWith('SOPORTE')) {
        const [ins] = await db.query(
          `INSERT INTO usuarios (assembly_id, identificador_unico, nombre_completo, unidad, coeficiente, rol)
           VALUES (?, ?, 'Soporte Técnico', 'SOPORTE', 0.00000, 'soporte')`,
          [targetAssembly, targetId]
        );
        rows = [{ id: ins.insertId, identificador_unico: targetId, nombre_completo: 'Soporte Técnico', unidad: 'SOPORTE', coeficiente: 0.00000, rol: 'soporte' }];
      }

      if (rows.length === 0) return socket.emit('auth:error', 'Usuario o correo no registrado.');

      const user = rows[0];

      if (!isConsoleAdmin && user.password && user.password.trim() !== '' && user.rol === 'asistente') {
        if (!targetPassword) {
          return socket.emit('auth:error', 'Ingresa tu contraseña.');
        }
        const isMatch = await bcrypt.compare(targetPassword, user.password);
        if (!isMatch) {
          return socket.emit('auth:error', 'Contraseña incorrecta.');
        }
      }

      const userId = user.id;
      const isControlRole = ['superadmin', 'administrador', 'moderador', 'representante_legal', 'soporte'].includes((user.rol || '').toLowerCase());
      const sessionKey = (isConsoleAdmin || userId === 0)
        ? `${targetAssembly}_CONSOLE_${userId}_${socket.id}`
        : `${targetAssembly}_${userId}`;

      if (!isConsoleAdmin && userId > 0 && !isControlRole && activeSessions.has(sessionKey)) {
        const existingSession = activeSessions.get(sessionKey);
        if (existingSession.socketId !== socket.id) {
          io.to(existingSession.socketId).emit('auth:kicked', { message: 'Tu sesión ha sido iniciada en otro dispositivo.' });
        }
      }

      if (!isConsoleAdmin) {
        activeSessions.set(sessionKey, {
          userId,
          assemblyId: targetAssembly,
          socketId: socket.id,
          identificadorUnico: user.identificador_unico,
          nombreCompleto: user.nombre_completo,
          unidad: user.unidad,
          rol: user.rol
        });
        socketUserMap.set(socket.id, sessionKey);
        socket.sessionKey = sessionKey;
      }

      socket.assemblyId = targetAssembly;
      socket.userId = userId;
      socket.identificadorUnico = user.identificador_unico;
      socket.nombreCompleto = user.nombre_completo;
      socket.unidad = user.unidad;

      const roomName = `assembly_${targetAssembly}`;
      socket.join(roomName);

      const { coefPoderes, representadosAprobados, representadosPendientes, isRepresented } = await getUserPowerDetails(userId, targetAssembly);
      user.coeficientePropio = parseFloat(user.coeficiente) || 0;
      user.coeficientePoderes = coefPoderes;
      user.coeficienteEfectivo = (isRepresented || user.rol === 'soporte' || userId === 0) ? 0 : (user.coeficientePropio + coefPoderes);
      user.isRepresented = isRepresented;
      user.poderesAprobados = representadosAprobados;
      user.poderesPendientes = representadosPendientes;

      socket.emit('auth:success', { user, room: roomName });

      const chatHistoryAssembly = memoryChat.filter(m => parseInt(m.assemblyId) === targetAssembly && !m.esManoLevantada);
      const isPausedNow = assemblyChatActive.get(targetAssembly) === false;
      const pinnedNow = assemblyPinnedMessage.get(targetAssembly) || null;
      const mutedSet = getMutedSetForAssembly(targetAssembly);
      const mutedArray = Array.from(mutedSet);
      const raisedHandsNow = getRaisedHandsForAssembly(targetAssembly);
      const mediaPermsObj = serializeMediaPermissions(targetAssembly);

      socket.emit('chat:history', {
        messages: chatHistoryAssembly,
        paused: isPausedNow,
        pinnedMessage: pinnedNow,
        mutedUsers: mutedArray,
        raisedHands: raisedHandsNow,
        mediaPermissions: mediaPermsObj
      });

      socket.emit('media:permissions_updated', {
        mediaPermissions: mediaPermsObj
      });

      if (assemblyDraftPreview.has(targetAssembly)) {
        socket.emit('question:draft_preview', assemblyDraftPreview.get(targetAssembly));
      }

      await updateAndBroadcastQuorum(targetAssembly);

      if (activeQuestions.has(targetAssembly)) {
        const activeQ = activeQuestions.get(targetAssembly);
        const stats = await getVotingStats(targetAssembly, activeQ.id);
        const resultados = await calculateWeightedResults(targetAssembly, activeQ.id);
        const [votoUsuario] = await db.query(`SELECT opcion_id FROM votos WHERE pregunta_id = ? AND usuario_id = ?`, [activeQ.id, userId]);
        socket.emit('voting:current_state', { ...activeQ, stats, resultados, myCurrentVote: votoUsuario.length > 0 ? votoUsuario[0].opcion_id : null });
      }
    } catch (error) {
      console.error('Error al autenticar socket:', error);
      socket.emit('auth:error', 'Error interno al autenticar.');
    }
  });

  socket.on('auth:refresh_user', async () => {
    try {
      const { assemblyId, userId } = socket;
      if (!assemblyId || !userId) return;

      const [rows] = await db.query(
        `SELECT id, identificador_unico, nombre_completo, unidad, email, coeficiente, rol FROM usuarios WHERE id = ?`,
        [userId]
      );
      if (rows.length === 0) return;

      const user = rows[0];
      const { coefPoderes, representadosAprobados, representadosPendientes, isRepresented } = await getUserPowerDetails(userId, assemblyId);
      user.coeficientePropio = parseFloat(user.coeficiente) || 0;
      user.coeficientePoderes = coefPoderes;
      user.coeficienteEfectivo = (isRepresented || user.rol === 'soporte') ? 0 : (user.coeficientePropio + coefPoderes);
      user.isRepresented = isRepresented;
      user.poderesAprobados = representadosAprobados;
      user.poderesPendientes = representadosPendientes;

      socket.emit('user:coef_updated', { user });
    } catch (err) {
      console.error('Error en auth:refresh_user:', err);
    }
  });

  // =========================================================================
  // CONTROL DE PERMISOS DE MICRÓFONO Y CÁMARA POR COPROPIETARIO DESDE ADMIN
  // =========================================================================
  socket.on('admin:toggle_user_media', ({ assemblyId, targetKey, mediaType, allow }) => {
    const targetAssembly = parseInt(assemblyId || socket.assemblyId || 1);
    if (!targetKey || !['mic', 'cam'].includes(mediaType)) return;

    const cleanKey = String(targetKey).trim().toUpperCase();
    const map = getMediaPermissionsMapForAssembly(targetAssembly);
    const current = map.get(cleanKey) || { mic: false, cam: false };

    current[mediaType] = !!allow;
    map.set(cleanKey, current);

    io.to(`assembly_${targetAssembly}`).emit('media:permissions_updated', {
      mediaPermissions: serializeMediaPermissions(targetAssembly),
      changedKey: cleanKey,
      changedType: mediaType,
      allowed: !!allow
    });
  });

  // Revocar micrófono y cámara a todos los copropietarios de un solo clic
  socket.on('admin:revoke_all_media', ({ assemblyId }) => {
    const targetAssembly = parseInt(assemblyId || socket.assemblyId || 1);
    assemblyMediaPermissions.set(targetAssembly, new Map());

    io.to(`assembly_${targetAssembly}`).emit('media:permissions_updated', {
      mediaPermissions: {},
      revokedAll: true
    });
  });

  socket.on('admin:zoom_host_started', async ({ assemblyId }) => {
    const targetAssembly = parseInt(assemblyId || socket.assemblyId || 1);
    assemblyZoomOpen.set(targetAssembly, true);
    try {
      await db.query(`UPDATE asambleas SET zoom_habilitado = 1 WHERE id = ?`, [targetAssembly]);
    } catch (e) {}
    const streamData = await getAssemblyZoomStreamInfo(targetAssembly);
    io.to(`assembly_${targetAssembly}`).emit('zoom:updated', { streamInfo: streamData });
  });

  socket.on('admin:typing_question', ({ assemblyId, isTyping, textoPregunta, duracionSegundos, opciones }) => {
    const targetAssembly = parseInt(assemblyId || socket.assemblyId || 1);
    if (!isTyping || !textoPregunta || textoPregunta.toString().trim() === '') {
      assemblyDraftPreview.delete(targetAssembly);
      io.to(`assembly_${targetAssembly}`).emit('question:draft_preview', { isTyping: false });
      return;
    }

    const draftPayload = {
      isTyping: true,
      textoPregunta: textoPregunta.toString().trim(),
      duracionSegundos: parseInt(duracionSegundos) || 60,
      opciones: Array.isArray(opciones) ? opciones : []
    };

    assemblyDraftPreview.set(targetAssembly, draftPayload);
    io.to(`assembly_${targetAssembly}`).emit('question:draft_preview', draftPayload);
  });

  // COLA ENUMERADA DE LEVANTAR / BAJAR LA MANO
  socket.on('chat:toggle_hand', ({ assemblyId, userId, identificadorUnico, nombreCompleto, unidad, raise }) => {
    const targetAssembly = parseInt(assemblyId || socket.assemblyId || 1);
    const effectiveUserId = userId !== undefined ? userId : (socket.userId || 0);
    const effectiveIdentificador = (identificadorUnico || socket.identificadorUnico || String(effectiveUserId)).toString().trim().toUpperCase();
    const effectiveNombre = (nombreCompleto || socket.nombreCompleto || 'Asistente').toString().trim();
    const effectiveUnidad = (unidad || socket.unidad || '---').toString().trim();

    if (!effectiveIdentificador) return;

    const handsQueue = getRaisedHandsForAssembly(targetAssembly);
    const existingIdx = handsQueue.findIndex(h => h.key === effectiveIdentificador);

    if (raise) {
      if (existingIdx === -1) {
        const horaStr = new Date().toLocaleTimeString('es-CO', { timeZone: 'America/Bogota', hour: '2-digit', minute: '2-digit' });
        handsQueue.push({
          key: effectiveIdentificador,
          userId: effectiveUserId,
          identificadorUnico: effectiveIdentificador,
          nombreCompleto: effectiveNombre,
          unidad: effectiveUnidad,
          hora: horaStr,
          timestamp: Date.now()
        });
      }
    } else {
      if (existingIdx !== -1) {
        handsQueue.splice(existingIdx, 1);
      }
    }

    io.to(`assembly_${targetAssembly}`).emit('chat:hands_updated', {
      raisedHands: handsQueue
    });
  });

  socket.on('admin:lower_hand', ({ assemblyId, targetKey }) => {
    const targetAssembly = parseInt(assemblyId || socket.assemblyId || 1);
    if (!targetKey) return;
    const cleanKey = String(targetKey).trim().toUpperCase();
    const handsQueue = getRaisedHandsForAssembly(targetAssembly);
    const idx = handsQueue.findIndex(h => h.key === cleanKey || String(h.userId).toUpperCase() === cleanKey);

    if (idx !== -1) {
      handsQueue.splice(idx, 1);
      io.to(`assembly_${targetAssembly}`).emit('chat:hands_updated', {
        raisedHands: handsQueue
      });
    }
  });

  socket.on('admin:clear_hands', ({ assemblyId }) => {
    const targetAssembly = parseInt(assemblyId || socket.assemblyId || 1);
    assemblyRaisedHands.set(targetAssembly, []);
    io.to(`assembly_${targetAssembly}`).emit('chat:hands_updated', {
      raisedHands: []
    });
  });

  socket.on('chat:message', ({ assemblyId, texto, emisor, unidad, esOficial, senderId, senderIdentificador }) => {
    const targetAssembly = parseInt(assemblyId || socket.assemblyId || 1);
    const isPaused = assemblyChatActive.get(targetAssembly) === false;

    if (isPaused && !esOficial) {
      return;
    }

    const effectiveUserId = senderId !== undefined ? senderId : (socket.userId || 0);
    const effectiveIdentificador = (senderIdentificador || socket.identificadorUnico || '').toString().trim().toUpperCase();

    const mutedSet = getMutedSetForAssembly(targetAssembly);
    if (
      !esOficial &&
      (
        (effectiveUserId && mutedSet.has(String(effectiveUserId))) ||
        (effectiveIdentificador && mutedSet.has(effectiveIdentificador))
      )
    ) {
      socket.emit('chat:error_muted', { message: 'Has sido silenciado en el chat por el moderador.' });
      return;
    }

    const msgData = {
      id: Date.now() + Math.floor(Math.random() * 1000),
      assemblyId: targetAssembly,
      userId: effectiveUserId,
      identificadorUnico: effectiveIdentificador,
      texto: (texto || '').toString().trim().slice(0, 300),
      emisor: emisor || 'Asistente',
      unidad: unidad || '---',
      esOficial: !!esOficial,
      hora: new Date().toLocaleTimeString('es-CO', { timeZone: 'America/Bogota', hour: '2-digit', minute: '2-digit' })
    };
    memoryChat.push(msgData);
    if (memoryChat.length > 1000) memoryChat.shift();
    io.to(`assembly_${targetAssembly}`).emit('chat:broadcast', msgData);
  });

  socket.on('admin:toggle_chat', ({ assemblyId, paused }) => {
    const targetAssembly = parseInt(assemblyId || socket.assemblyId || 1);
    assemblyChatActive.set(targetAssembly, !paused);
    io.to(`assembly_${targetAssembly}`).emit('chat:status', { paused: !!paused });
  });

  socket.on('admin:clear_chat', ({ assemblyId }) => {
    const targetAssembly = parseInt(assemblyId || socket.assemblyId || 1);
    for (let i = memoryChat.length - 1; i >= 0; i--) {
      if (parseInt(memoryChat[i].assemblyId) === targetAssembly) {
        memoryChat.splice(i, 1);
      }
    }
    assemblyPinnedMessage.delete(targetAssembly);
    io.to(`assembly_${targetAssembly}`).emit('chat:cleared');
    io.to(`assembly_${targetAssembly}`).emit('chat:pinned_updated', { pinnedMessage: null });
  });

  socket.on('admin:delete_chat_message', ({ assemblyId, messageId }) => {
    const targetAssembly = parseInt(assemblyId || socket.assemblyId || 1);
    const index = memoryChat.findIndex(m => parseInt(m.assemblyId) === targetAssembly && String(m.id) === String(messageId));
    if (index !== -1) {
      memoryChat.splice(index, 1);
    }

    const currentPinned = assemblyPinnedMessage.get(targetAssembly);
    if (currentPinned && String(currentPinned.id) === String(messageId)) {
      assemblyPinnedMessage.delete(targetAssembly);
      io.to(`assembly_${targetAssembly}`).emit('chat:pinned_updated', { pinnedMessage: null });
    }

    io.to(`assembly_${targetAssembly}`).emit('chat:message_deleted', { messageId });
  });

  socket.on('admin:pin_chat_message', ({ assemblyId, messageId }) => {
    const targetAssembly = parseInt(assemblyId || socket.assemblyId || 1);
    if (!messageId) {
      assemblyPinnedMessage.delete(targetAssembly);
      io.to(`assembly_${targetAssembly}`).emit('chat:pinned_updated', { pinnedMessage: null });
      return;
    }

    const foundMsg = memoryChat.find(m => parseInt(m.assemblyId) === targetAssembly && String(m.id) === String(messageId));
    if (foundMsg) {
      assemblyPinnedMessage.set(targetAssembly, foundMsg);
      io.to(`assembly_${targetAssembly}`).emit('chat:pinned_updated', { pinnedMessage: foundMsg });
    }
  });

  socket.on('admin:toggle_mute_user', ({ assemblyId, targetKey, mute }) => {
    const targetAssembly = parseInt(assemblyId || socket.assemblyId || 1);
    if (!targetKey) return;
    const cleanKey = String(targetKey).trim().toUpperCase();
    const mutedSet = getMutedSetForAssembly(targetAssembly);

    if (mute) {
      mutedSet.add(cleanKey);
    } else {
      mutedSet.delete(cleanKey);
    }

    io.to(`assembly_${targetAssembly}`).emit('chat:muted_users_updated', {
      mutedUsers: Array.from(mutedSet)
    });
  });

  socket.on('admin:start_voting', async ({ assemblyId, preguntaId, duracionSegundos }) => {
    try {
      const targetAssembly = parseInt(assemblyId) || 1;
      if (timerIntervals.has(targetAssembly)) clearInterval(timerIntervals.get(targetAssembly));
      await db.query(`UPDATE preguntas SET estado = 'activa' WHERE id = ? AND assembly_id = ?`, [preguntaId, targetAssembly]);

      const [preguntas] = await db.query(`SELECT id, texto_pregunta FROM preguntas WHERE id = ?`, [preguntaId]);
      const [opciones] = await db.query(`SELECT id, texto_opcion FROM opciones_pregunta WHERE pregunta_id = ? ORDER BY orden ASC`, [preguntaId]);
      if (preguntas.length === 0) return;

      const duracion = parseInt(duracionSegundos) || 60;
      const stats = await getVotingStats(targetAssembly, preguntaId);
      const resultados = await calculateWeightedResults(targetAssembly, preguntaId);
      const activeQData = { id: preguntas[0].id, texto: preguntas[0].texto_pregunta, opciones, duracion, tiempoRestante: duracion, isOpen: true, stats, resultados };

      activeQuestions.set(targetAssembly, activeQData);
      assemblyDraftPreview.delete(targetAssembly);
      const roomName = `assembly_${targetAssembly}`;

      io.to(roomName).emit('question:draft_preview', { isTyping: false });
      io.to(roomName).emit('voting:started', activeQData);
      io.to(roomName).emit('questions:updated');

      const interval = setInterval(async () => {
        const currentQ = activeQuestions.get(targetAssembly);
        if (!currentQ) { clearInterval(interval); return; }

        currentQ.tiempoRestante -= 1;
        io.to(roomName).emit('timer:tick', { tiempoRestante: currentQ.tiempoRestante });

        if (currentQ.tiempoRestante <= 0) {
          clearInterval(interval);
          timerIntervals.delete(targetAssembly);
          currentQ.isOpen = false;

          await db.query(`UPDATE preguntas SET estado = 'cerrada' WHERE id = ?`, [preguntaId]);
          const finalResults = await calculateWeightedResults(targetAssembly, preguntaId);
          const finalStats = await getVotingStats(targetAssembly, preguntaId);

          io.to(roomName).emit('voting:closed', { preguntaId, resultados: finalResults, stats: finalStats });
          io.to(roomName).emit('questions:updated');
          activeQuestions.delete(targetAssembly);
        }
      }, 1000);

      timerIntervals.set(targetAssembly, interval);
    } catch (error) {
      console.error('Error al iniciar votación:', error);
    }
  });

  socket.on('admin:stop_voting', async ({ assemblyId, preguntaId }) => {
    try {
      const targetAssembly = parseInt(assemblyId) || 1;
      if (timerIntervals.has(targetAssembly)) {
        clearInterval(timerIntervals.get(targetAssembly));
        timerIntervals.delete(targetAssembly);
      }
      const currentQ = activeQuestions.get(targetAssembly);
      if (currentQ) { currentQ.isOpen = false; activeQuestions.delete(targetAssembly); }

      await db.query(`UPDATE preguntas SET estado = 'cerrada' WHERE id = ? AND assembly_id = ?`, [preguntaId, targetAssembly]);
      const finalResults = await calculateWeightedResults(targetAssembly, preguntaId);
      const finalStats = await getVotingStats(targetAssembly, preguntaId);

      const roomName = `assembly_${targetAssembly}`;
      io.to(roomName).emit('voting:closed', { preguntaId, resultados: finalResults, stats: finalStats });
      io.to(roomName).emit('questions:updated');
    } catch (error) {
      console.error('Error al detener votación:', error);
    }
  });

  socket.on('vote:submit', async ({ opcionId }) => {
    const { assemblyId, userId } = socket;
    if (!assemblyId || !userId) return;

    const currentQ = activeQuestions.get(assemblyId);
    if (!currentQ || !currentQ.isOpen) return;

    try {
      const { isRepresented, apoderadoNombre } = await checkUserRepresentedStatus(userId, assemblyId);
      if (isRepresented) {
        return socket.emit('vote:rejected', { message: `No puedes votar directamente. Tus derechos de voto están delegados por poder autorizado a ${apoderadoNombre}.` });
      }

      const [poderesAprobados] = await db.query(
        `SELECT p.otorgante_id, u.coeficiente
         FROM poderes p
         JOIN usuarios u ON p.otorgante_id = u.id
         WHERE p.apoderado_id = ? AND p.assembly_id = ? AND p.estado = 'autorizado'`,
        [userId, assemblyId]
      );

      const [u] = await db.query(`SELECT id, coeficiente, rol FROM usuarios WHERE id = ?`, [userId]);
      if (u.length === 0) return;

      const voterList = [];

      if (u[0].rol !== 'soporte') {
        const propioCoef = parseFloat(u[0].coeficiente) || 0;
        if (propioCoef > 0 || poderesAprobados.length === 0) {
          voterList.push({ usuarioId: u[0].id, coef: propioCoef });
        }
      }

      for (const pod of poderesAprobados) {
        voterList.push({ usuarioId: pod.otorgante_id, coef: parseFloat(pod.coeficiente) || 0 });
      }

      if (voterList.length === 0) {
        return socket.emit('vote:rejected', { message: 'Tu coeficiente habilitado de voto es 0.0000%.' });
      }

      for (const target of voterList) {
        await db.query(
          `INSERT INTO votos (assembly_id, pregunta_id, usuario_id, opcion_id, coeficiente_aplicado)
           VALUES (?, ?, ?, ?, ?)
           ON DUPLICATE KEY UPDATE opcion_id = VALUES(opcion_id), coeficiente_aplicado = VALUES(coeficiente_aplicado)`,
          [assemblyId, currentQ.id, target.usuarioId, opcionId, target.coef]
        );
      }

      socket.emit('vote:confirmed', { opcionId });
      
      const updatedResults = await calculateWeightedResults(assemblyId, currentQ.id);
      const stats = await getVotingStats(assemblyId, currentQ.id);
      
      io.to(`assembly_${assemblyId}`).emit('voting:results_update', { preguntaId: currentQ.id, resultados: updatedResults, stats });
    } catch (error) {
      console.error('Error al registrar voto:', error);
    }
  });

  socket.on('disconnect', async () => {
    if (socket.sessionKey && activeSessions.has(socket.sessionKey)) {
      const sessionData = activeSessions.get(socket.sessionKey);
      if (sessionData.socketId === socket.id) {
        activeSessions.delete(socket.sessionKey);
        socketUserMap.delete(socket.id);
        await updateAndBroadcastQuorum(sessionData.assemblyId);
      }
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 Servidor de Asambleas v3.5.0-media-permissions corriendo en puerto ${PORT}`));
