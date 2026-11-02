# Contrato funcional y comercial v1.0 | DRAFT
## Rutas / interacción
Mantener / y #agenda, #contacto, identidad visual; #cursos se convierte en catálogo. Cuatro productos con slugs estables: endometriosis, vaginosis, sop, aprende-mujer; pack: mujer-informada-4. Cada ficha: título, alcance revisado por doctor, temario, duración (si confirmada), precio (tras aprobación), qué incluye: video ~10 min, SCORM, infografía, PDF/presentación y evaluación educativa, FAQ, aviso educativo, CTA individual y paquete.
No alojar ni reproducir gratuitamente videos completos de los cursos. Contenido gratuito solo el que el doctor publica explícitamente en sus redes. CTA compra: enviar al checkout seguro. No usar botones de apariencia funcional sin acción.

## Conversión
Visita con utm_source/utm_medium/utm_campaign/utm_content; persistir atribución en sesión con consentimiento aplicable; lead capture opcional desde muestra, obligatorio para pedido; mínimo nombre, email o teléfono validado para acceso y seguimiento transaccional, más aceptación términos/privacidad. Marketing consent separado y no premarcado. La compra no se supedita a opt-in publicitario. Evitar recolectar patologías, síntomas o estado de salud.

## Máquina de estados de pedido
draft -> pending_payment -> paid_verified -> enrollment_pending -> fulfilled.
Transiciones excepcionales: expired, cancelled, payment_review, enrollment_failed, refunded.
paid_verified SOLO por conciliación de operador autorizado o webhook firmado del PSP, nunca por comprobante recibido. fulfilled SOLO tras confirmación Moodle para 1 curso o 4 del pack. Registro auditado de actor, fecha y motivo. Repetición de confirmación/matrícula debe ser idempotente. Nunca asignar pack parcial como fulfilled.

## Plan de validación comercial
Individual Bs 79 / pack Bs 199 son precios propuestos para validación comercial, no configuración de producción hasta aprobación. Precio guardado inmutable en cada pedido, moneda BOB, cálculo del servidor. Comunicar descuentos sobre 4x79 solo si los individuales realmente se ofrecen a ese precio. Sin descuento falso ni cuenta regresiva artificial.

## Errores y soporte
Si API no responde: pedido se mantiene sin matrícula, se alerta al operador y se ofrece soporte; nunca decir "acceso otorgado". Si QR no conciliado: mantener pending_payment y comunicar tiempo/medio de verificación verificado. Si pago duplicado: revisión y tratamiento operativo según política. Mensajes educativos no constituyen consejo médico individual.

## Curso y derivación médica
Cada producto entrega video educativo (~10 min), actividad SCORM, infografía, presentación/PDF y evaluación de conocimientos con feedback; verificar material realmente cargado antes de publicar claims. Llamarlo autoevaluación educativa, nunca diagnóstico clínico. Consulta del doctor siempre opcional y con canal independiente; nunca condicionar contenido o resultados al agendamiento. No transferir respuestas clínicas a CRM comercial.
