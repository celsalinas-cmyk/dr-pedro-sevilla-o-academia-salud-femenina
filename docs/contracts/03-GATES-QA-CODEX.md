# Gates QA + instrucción ejecutable para Codex v1.0 | DRAFT
## Procedimiento de ingeniería
1. Antes de cualquier modificación de código, leer 00,01,02,03 completos y presentar plan/diff propuesto.
2. Emitir matriz REQ->archivo->prueba->evidencia. No introducir nuevo framework, backend/DB/PSP sin ADR aprobado.
3. Un PR por gate, con evidencia y rollback. Nunca modificar main directamente. Tests automatizados si aplican y smoke manual en móvil.
4. QA independiente aprueba por escrito. Gate siguiente inicia únicamente si anterior PASS.
5. Si faltan URL video/ID Moodle/QR/PSP, usar contenido 'próximamente' SOLO en staging, nunca pedir pago real ni simular confirmaciones en producción.

## Casos de aceptación
G1: (a) cuatro tarjetas completas; (b) CTA pack y singles, sin botones rotos; (c) video gratuito reproduce únicamente recurso permitido; (d) visual 360px/768px/desktop; (e) agenda y contacto médico conservados; (f) teclado/semántica/contraste básicos; (g) 0 secretos expuestos.
G2: (a) formulario crea lead en DB, no apuntar a placeholder; (b) marketing opt-in separado; (c) UTMs capturados; (d) duplicados manejados; (e) una orden fija precio backend; (f) éxito/fallo explícitos; (g) exportación minimizada, segura.
G3: (a) QR no prueba pago; (b) operador verifica acreditación; (c) falta de pago no matricula; (d) pago verificado curso individual matricula exactamente uno; (e) pack matricula cuatro; (f) reintento no duplica; (g) error Moodle alerta y bloquea estado fulfilled.
G4: (a) mínimo 2 pruebas completas individuales + 2 pack de punta a punta en sandbox o entorno controlado; (b) un caso de fallo y recuperación por integración; (c) métricas muestran fuentes y embudo real; (d) rollback probado; (e) costos y owner de operación documentados; (f) aprobación comercial, clínica, técnica y seguridad.

## Prompt de trabajo para Codex
Eres implementador senior del proyecto Dr. Pedro Sevilla. La fuente de verdad son docs/contracts/*.md en rama de contratos aprobada. Primero analiza index.html y css/styles.css, presenta plan mínimo y dependencias, y NO escribas código hasta que el Product Owner autorice el Gate 1. Trabaja exclusivamente en rama feature. No inventes integraciones, credenciales, URLs, pagos, precios aprobados ni datos clínicos. Mantén el sitio existente; entrega PR incremental con pruebas, evidencia y rollback. Bloquea todo requisito no verificado y reporta alternativas. No pases al siguiente gate por iniciativa propia.
