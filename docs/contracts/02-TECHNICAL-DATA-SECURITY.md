# Contrato técnico, datos, integraciones y seguridad v1.0 | DRAFT
## Arquitectura
Frontend existente: index.html + css/styles.css; JS progresivo, accesible, responsive. Backend independiente HTTPS obligatorio para POST /leads, POST /orders, GET /orders/:public_token/status y acciones ADMIN de conciliación/matrícula autenticadas. No introducir plataforma externa sin ADR comparando costo, operación y privacidad. Alojamiento exacto y DB PENDIENTES. No asumir que hosting actual admite ejecución de backend.

## Entidades mínimas
catalog_products(id, slug, title, is_active, moodle_course_id_nullable);
prices(id, product_id_or_bundle, currency, amount_minor, effective_from, approved_by);
leads(id, name, contact_email_nullable, contact_phone_nullable, origin_utm, created_at, marketing_opt_in, consent_version, consent_at);
orders(id, lead_id, amount_minor, currency, status, created_at, expires_at, source_utm, idempotency_key);
order_lines(order_id, product_id, price_minor);
payments(id, order_id, method, reference_nullable, verification_status, verified_at, verified_by, evidence_reference_nullable);
enrollments(id, order_id, product_id, moodle_user_id_nullable, moodle_course_id, state, attempts, last_error_code);
audit_events(id, entity_type, entity_id, action, actor_id, at, metadata_redacted).
Emails/phones: normalización, mínimos necesarios y reglas de retención aprobadas. No almacenar datos clínicos.

## Contratos API orientativos (no implementar sin validación)
POST /api/leads {name, email?, phone?, marketing_opt_in:boolean, consent_version, utm:{source?,medium?,campaign?,content?}} -> {lead_id}
POST /api/orders {lead_id, sku, idempotency_key} -> {order_id, amount_minor, currency:"BOB", status:"pending_payment", payment_instructions}
GET /api/orders/{opaque_token}/status -> {status, enrollment_status}; token opaco de alta entropía, expiración y limitación de tasa.
POST /api/admin/orders/{id}/verify-payment -> autenticación + rol + evidencia de acreditación conciliada; nunca públicamente accesible.
Los precios y SKU se resuelven en servidor. Validar payloads y rate limits; captcha/honeypot antispam sujeto a protección de datos.

## Moodle
Usar API REST con cuenta técnica de permisos mínimos, token servidor, TLS, operaciones idempotentes, trazabilidad de mapeos curso/usuario y reintento acotado. Verificar funciones efectivamente habilitadas, versiones y reglas de contraseña antes de implementar. Prohibido invocar endpoints de Moodle desde JS público. Preparar mecanismo manual de matrícula supervisada para etapa inicial.

## Privacidad y cumplimiento
Consentimiento transaccional/privacidad explícito, comunicaciones promocionales separadas; enlace de baja; política de retención y borrado, acceso por roles; sin testimonios no autorizados; sin datos de salud en CRM. Contenido clínico y mensajes revisados por profesional. Auditoría de pagos y reembolsos, reportes por cohortes sin PII. Cumplimiento legal y tributario boliviano debe revisarlo responsable designado.

## Fallos y amenazas
Prevenir IDOR, enumeración de órdenes, inyección, XSS, CSRF en acciones autenticadas, exposición de tokens, duplicación por reintentos, sobreventa de descuentos, inscripciones sin pago, logs con PII, hojas de cálculo públicas. Test de precios adulterados en browser, pago falso, doble click, refresh, API caída, inscripción parcial pack, pérdida de conectividad móvil.
