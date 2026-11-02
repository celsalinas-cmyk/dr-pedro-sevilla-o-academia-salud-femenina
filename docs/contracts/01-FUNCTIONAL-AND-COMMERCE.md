# Contrato funcional y comercial v1.0 | DRAFT
## Rutas / interacción
Mantener / y #agenda, #contacto, identidad visual; #cursos se convierte en catálogo. Cuatro productos con slugs estables: endometriosis, vaginosis, sop, aprende-mujer; pack: mujer-informada-4. Cada ficha: título, alcance revisado por doctor, temario, duración (si confirmada), precio (tras aprobación), lección gratis (solo si existe), FAQ, aviso educativo, CTA individual y paquete.
CTA video: reproducir recurso autorizado; CTA compra: enviar al checkout seguro. No usar botones de apariencia funcional sin acción.

## Conversión
Visita con utm_source/utm_medium/utm_campaign/utm_content; persistir atribución en sesión con consentimiento aplicable; lead capture opcional desde muestra, obligatorio para pedido; mínimo nombre, email o teléfono validado para acceso y seguimiento transaccional, más aceptación términos/privacidad. Marketing consent separado y no premarcado. La compra no se supedita a opt-in publicitario. Evitar recolectar patologías, síntomas o estado de salud.

## Máquina de estados de pedido
draft -> pending_payment -> paid_verified -> enrollment_pending -> fulfilled.
Transiciones excepcionales: expired, cancelled, payment_review, enrollment_failed, refunded.
paid_verified SOLO por conciliación de operador autorizado o webhook firmado del PSP, nunca por comprobante recibido. fulfilled SOLO tras confirmación Moodle para 1 curso o 4 del pack. Registro auditado de actor, fecha y motivo. Repetición de confirmación/matrícula debe ser idempotente. Nunca asignar pack parcial como fulfilled.

## Plan de validación comercial
Individual Bs 59 / pack Bs 149 son hipótesis, no configuración de producción hasta aprobación. Precio guardado inmutable en cada pedido, moneda BOB, cálculo del servidor. Comunicar descuentos sobre 4x59 solo si los individuales realmente se ofrecen a ese precio. Sin descuento falso ni cuenta regresiva artificial.

## Errores y soporte
Si API no responde: pedido se mantiene sin matrícula, se alerta al operador y se ofrece soporte; nunca decir "acceso otorgado". Si QR no conciliado: mantener pending_payment y comunicar tiempo/medio de verificación verificado. Si pago duplicado: revisión y tratamiento operativo según política. Mensajes educativos no constituyen consejo médico individual.
