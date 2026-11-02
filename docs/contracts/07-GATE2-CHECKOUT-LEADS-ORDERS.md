# Gate 2 — Contrato de checkout, captación y pedidos v1.0
Fecha: 2026-11-01 | Estado: PLAN-ONLY / PENDIENTE DE APROBACIÓN TÉCNICA Y COMERCIAL
Fuente de verdad: docs/contracts/00..06. Gate 1 aprobado visual/técnico; PR #1 separado, sin permiso implícito de merge o deploy.

## Objetivo acotado
Convertir CTA de un curso o pack en un único checkout seguro y en un pedido persistente trazable. NO cobrar realmente ni matricular en Moodle durante el alcance inicial de Gate 2; preparar contratos para Gate 3. AVERA Health y consultas médicas fuera de alcance.

## Journey
Red social / URL UTM -> catálogo -> Comprar curso / Comprar los 4 -> checkout con producto elegido -> confirmar identidad/contacto/consentimiento -> backend crea pedido inmutable con precio de servidor -> estado pendiente de pago e instrucciones cuando disponibles -> confirmación de compra solo después de verificación en Gate 3.
Producto individual: endometriosis, vaginosis, sop, aprende-mujer. Bundle: mujer-informada-4. Precios propuestos Bs 79 / Bs 199, bloqueados hasta confirmación del titular comercial. No permitir precios desde navegador.

## UX checkout
Paso único o máximo dos pantallas en móvil. Resumen claro, producto, contenido, precio final, política de acceso, privacidad y reembolso. Nombre, correo (necesario para Moodle), WhatsApp opcional salvo justificación operativa. Consentimiento de términos/privacidad obligatorio y marketing separado opcional, no premarcado. Confirmación explícita solo si backend guardó pedido. No preguntar síntomas, diagnósticos ni documentos de identidad sin obligación legal acreditada. Eliminar barreras y scroll excesivo.

## Arquitectura provisional — decisión obligatoria antes de codificar
Conservar HTML/CSS/JS de web estática en Hostinger; NO asumir que soporta servidor propio. Antigravity debe analizar opciones: (A) backend ligero alojado en infraestructura existente NOVARUM, (B) API serverless gestionada, (C) hosting backend en Hostinger si plan compatible. Comparar costos, mantenimiento, disponibilidad, logs, privacidad, copias de seguridad, recuperación, acceso a Moodle y bloqueo de abuso. NO elegir stack ni DB por iniciativa propia: presentar ADR.
La DB debe persistir leads, consentimiento, orders, order_lines, estado, eventos auditables e idempotencia. Única fuente de precios server-side. Credenciales solo en variables seguras del servidor.

## Contratos mínimos (propuesta, no API definitiva)
POST /api/leads  {name,email,phone?,privacy_version,marketing_opt_in:false|true,utm:{...}} -> {lead_id}
POST /api/orders {lead_id,sku,idempotency_key} -> {order_id,status:'pending_payment',currency:'BOB',amount_minor}
GET /api/orders/{opaque_token}/status -> {status} sin revelar PII; token de alta entropía y rate limiting.
Estados: draft, pending_payment, payment_review, paid_verified, enrollment_pending, fulfilled, expired, cancelled, refunded, enrollment_failed.
Acciones privilegiadas de conciliación y matrícula se dejan especificadas para Gate 3.

## Canal / atribución
TikTok/Instagram/web con UTM source/medium/campaign/content; conservar etiqueta de fuente y eventos de funnel, sin trackers clínicos ni compartir datos sensibles. WhatsApp 69058830 agenda, 78456338 academia propuestos sujetos a confirmación real; no usar WhatsApp como checkout. Leads y pedidos con deduplicación e idempotencia.

## Seguridad y privacidad
HTTPS, validación server-side, mitigación de XSS/CSRF/IDOR, límites de tasa, spam, no mostrar errores internos o tokens, least privilege para operadores. Política de retención y eliminación; acceso a datos por roles; bitácora de estados; backups y rollback; medidas anti-duplicado y recuperación de pedidos. Evaluación legal del tratamiento de datos, facturación e impuestos antes del lanzamiento.

## Exclusiones
Cobro real, QR bancario definitivo, pasarela, webhook, conciliación, generación de credenciales, Moodle API, campañas de mensajería automática, CRM universal, captación de datos clínicos, AVERA Health. Gate 2 no altera core Moodle.

## Gates y pruebas
G2-P (plan): ADR de arquitectura+costos, diagrama flujo de datos, pantallas checkout, esquema DB, API, amenazas, plan de QA, rollback y operación aprobados.
G2-A (staging): navegación móvil desde cuatro CTA y pack hacia checkout, preservación de SKU y UTM, precio inalterable, prueba de persistencia y fallo seguro; consentimientos correctos; validación de email; spam/rate limit; doble click produce una sola orden; nunca estado paid desde browser. Sin facturación ni matrícula.
G2-EXIT: pruebas PASS, QA independiente, respaldo, logs con mínima PII, PR revisado y Product Owner aprueba explícitamente. Merge y despliegue independientes.

## Información pendiente: no improvisar
Confirmación formal precios 79/199; titular que factura y emite recibo; entidad bancaria/cuenta y responsable de conciliación; política de reembolso y duración de acceso; disponibilidad infraestructura backend/DB; permisos operativos Moodle; texto legal/consentimiento y servicio de soporte. Lo pendiente de Gate 3 no bloquea análisis G2-P.

## Instrucción para Antigravity (solo PLAN-ONLY)
Lee contratos 00 a 07; inspecciona sitio y PR #1. Presenta alternativas de backend con recomendación razonada; wireframe checkout móvil; diagrama de datos; endpoints y pruebas REQ->test->evidencia; presupuesto mensual y operación. Identifica decisiones bloqueantes y dependencias sin crear código, commits ni cambios en producción. No iniciar integración bancaria ni Moodle. Detente y solicita revisión del plan.
