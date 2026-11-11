# NOVAFORGE — Plan de Simplificación del MVP y Mini CRM de Seguimiento RR. SS.

**Proyecto:** NOVARUM Social Commerce & Enrollment Engine  
**Cliente inicial:** Dr. Pedro Sevilla — Academia Mujer Sana (`dr-sevilla`)  
**Rama:** `feature/gate2-a3-a1-admin-core` ([PR #5](https://github.com/celsalinas-cmyk/dr-pedro-sevilla-o-academia-salud-femenina/pull/5))  
**Referencia de Producto:** [Decisión del Product Owner (#issuecomment-6804158203)](https://github.com/celsalinas-cmyk/dr-pedro-sevilla-o-academia-salud-femenina/pull/5#issuecomment-6804158203)

---

## 1. Enmienda de Alcance Contractual del MVP (`ETAPA 1`)

El MVP se orienta como un **Mini CRM especializado de Social Commerce & Enrollment** operado por personal humano designado, cuya métrica principal de punta a punta es:

$$\text{Interesados gestionados (RR. SS.)} \longrightarrow \text{Pedidos (Checkout)} \longrightarrow \text{Pagos confirmados (QR humano)} \longrightarrow \text{Matrículas (Moodle)}$$

### 1.1 Funciones que Permanecen Activas en el MVP (`8cd78b8`)
- **Autenticación, sesiones y control de acceso:** Login/logout nominal con `scrypt`, sesiones revocables de 8h en PostgreSQL (`HttpOnly; SameSite=Strict`), protección CSRF (`X-CSRF-Token` + `Origin`), anti-suplantación y separación de tres roles (`academic_operator`, `finance_verifier`, `academy_admin`).
- **Bandeja y detalle de pedidos (`dr-sevilla`):** `GET /api/v1/admin/orders` y `GET /api/v1/admin/orders/:order_id`.
- **Coordinación manual de QR y seguimiento (`T-01`):** `POST /api/v1/admin/orders/:order_id/coordination` (`qr_sent`, `receipt_received`, `payment_discrepancy`) sin marcar el pedido como pagado (`pending_payment`).
- **Confirmación manual autorizada de pago (`T-02`):** `POST /api/v1/admin/orders/:order_id/verify-payment` con validación de importe exacto, moneda `BOB`, cuenta receptora y `bank_reference` única (`standard_reference`).
- **Matrícula manual en Moodle y entrega (`T-03`, `T-04`):** `POST /api/v1/admin/orders/:order_id/start-enrollment` y `POST /api/v1/admin/orders/:order_id/confirm-enrollment`, exigiendo `paid_verified` previo (`409 ENROLLMENT_REQUIRES_PAID_VERIFIED`) y los 4 cursos verificados para el pack `mujer-informada-4`.
- **Cancelación de pedido impago (`T-07`):** `POST /api/v1/admin/orders/:order_id/cancel`.

### 1.2 Funciones Financieras Pospuestas (Fuera del Flujo Operativo MVP)
- Conciliación bancaria sin referencia estándar (`manual_resolution`).
- Reimputación financiera entre pedidos (`POST /api/v1/admin/orders/:order_id/reallocate-reconciliation`).
- Reversiones financieras complejas (`POST /api/v1/admin/orders/:order_id/reverse`) y reactivación tardía (`POST /api/v1/admin/orders/:order_id/verify-late-payment`).
- Integraciones directas con APIs bancarias, generación automática de QR y provisión automática en Moodle.

### 1.3 Protección de Migraciones, Abonos e Historial
- No se elimina ninguna migración (`001` a `004`) ni registro histórico.
- La tabla `payment_reconciliations`, su índice único incondicional `uq_payment_reconciliations_bank_ref` (que reserva permanentemente toda referencia aplicada, revertida o anulada) y los triggers append-only (`trg_order_events_immutable` y `trg_payment_reconciliations_no_delete`) en `backend/migrations/004_admin_operations_and_reconciliation.sql` permanecen intactos en base de datos.

---

## 2. Componentes Existentes del Repositorio a Reutilizar

| Archivo / Componente Existente | Reutilización en el Mini CRM de Social Commerce |
| :--- | :--- |
| `backend/migrations/001_initial_schema.sql` y `002_seed_dr_sevilla_catalog.sql` | Aislamiento multi-academia (`academy_id = 'dr-sevilla'`), tabla `leads` (`email_normalized`, `name`, `phone`) y catálogo oficial de 5 SKUs (`mujer-informada-4`, `endometriosis`, `vaginosis`, `sop`, `aprende-mujer`). |
| `backend/migrations/003_orders_token_expiration_and_utm.sql` | Columnas de atribución ya presentes en `orders` (`utm_source`, `utm_medium`, `utm_campaign`, `utm_content`, `utm_term`). |
| `backend/migrations/004_admin_operations_and_reconciliation.sql` | Tablas `admin_operators` (para asignar responsable de seguimiento en `assigned_operator_id`), `admin_sessions`, `payment_reconciliations` y bitácora inmutable `order_events`. |
| `backend/src/services/admin-auth.service.js` (`AdminAuthService`) | Autenticación por cookie `HttpOnly`, validación CSRF, control anti-spoofing y autorización por rol para proteger las rutas del Mini CRM. |
| `backend/src/services/checkout.service.js` (`CheckoutService`) | Normalización de correo/teléfono, validación estricta de parámetros UTM (`validateUtmParams`) y creación transaccional de `leads` y `orders`. |
| `backend/src/services/admin-operations.service.js` (`AdminOperationsService`) | Consultas de pedidos, eventos de coordinación de QR, verificación bancaria y confirmación de matrícula Moodle. |
| `js/checkout.js` e `index.html` | Captura automática en navegador de `utm_source`, `utm_medium`, `utm_campaign`, `utm_content` y `utm_term` desde la URL pública y envío en `POST /api/v1/checkout`. |

---

## 3. Backlog Priorizado del Mini CRM (`BL-01` a `BL-06` — Alcance Cerrado)

> **Regla de Privacidad y Minimización:** Queda prohibido registrar diagnósticos, síntomas o información médica/clínica en el Mini CRM. Solo se almacenan datos de contacto consentido e interés comercial en los 5 productos educativos.

| ID | Prioridad | Elemento de Backlog | Alcance Específico |
| :--- | :---: | :--- | :--- |
| **BL-01** | **P1 (Inmediata)** | **Modelo mínimo de seguimiento de interesados (`social_inquiries`)** | Tabla incremental acotada por `academy_id` (`dr-sevilla`) con: origen RR. SS. (`channel`: `tiktok`, `instagram`, `whatsapp`, `web`), atribución (`utm_source`, `utm_medium`, `utm_campaign`), curso de interés (`interested_sku` validado contra `products`), contacto consentido (`contact_name`, `email_normalized`, `phone`), responsable (`assigned_operator_id` FK a `admin_operators`), estado de seguimiento (`followup_status`: `new_inquiry`, `contacted`, `checkout_link_sent`, `order_created`, `paid_verified`, `enrolled`, `closed_no_conversion`), `last_interaction_at`, `next_action`, `next_action_at` y `linked_order_id` (FK opcional a `orders`). |
| **BL-03** | **P1 (Inmediata)** | **Endpoints administrativos de la Bandeja de Interesados** | `GET /api/v1/admin/inquiries` (filtros por `followup_status`, `channel`, `interested_sku`, `assigned_operator_id`), `POST /api/v1/admin/inquiries` (alta idempotente de interesado con validación estricta y cero datos médicos) y `PATCH /api/v1/admin/inquiries/:inquiry_id` (asignar responsable, actualizar estado, registrar última interacción, definir próxima acción y vincular pedido). |
| **BL-04** | **P1 (Inmediata)** | **Vinculación con Checkout y Pedidos (`orders`)** | Asociación automática (por coincidencia de `email_normalized` o `phone` en `dr-sevilla`) o asistida por operador entre `social_inquiries` y `orders`, sincronizando el avance del interesado cuando el pedido pasa a `pending_payment`, `paid_verified` y `fulfilled`. |
| **BL-02** | **P2** | **Captación desde herramientas de terceros compatibles** | Generación de enlaces de checkout con parámetros UTM y SKU preseleccionado para uso en respuestas de TikTok, Instagram y WhatsApp mediante herramientas de terceros permitidas, respetando los límites, políticas y permisos de cada plataforma (sin construir conectores nativos propios). |
| **BL-06** | **P2** | **Indicadores operativos del embudo (`GET /api/v1/admin/metrics/funnel`)** | Consulta agregada para `dr-sevilla`: interesados gestionados, tiempo de primera respuesta, conversión a pedidos, pagos verificados y matrículas confirmadas en Moodle. |
| **BL-05** | **P3** | **Bandeja web operativa unificada** | Interfaz ligera para operadores con dos vistas conectadas: (1) Bandeja de Seguimiento RR. SS. y (2) Bandeja de Pedidos, QR y Matrícula Moodle. |

---

## 4. Diseño de Vinculación entre Seguimiento RR. SS., Checkout y Pedidos

1. **Captación y Enlace Atribuido:**
   - Una interesada consulta en TikTok, Instagram o WhatsApp por un curso (ej. `sop` o `mujer-informada-4`).
   - El operador registra o actualiza la consulta en `social_inquiries` (`followup_status = 'checkout_link_sent'`) y envía el enlace al catálogo/checkout con parámetros de atribución (`?utm_source=instagram&utm_medium=dm&utm_campaign=mujer_sana`).
2. **Registro del Pedido en el Checkout Existente (Sin Modificar Gate 2-A2):**
   - `js/checkout.js` lee automáticamente los parámetros `utm_*` de la URL y envía el payload a `POST /api/v1/checkout`.
   - `CheckoutService.processCheckout` persiste el `lead` (`email_normalized`, `phone`) y el pedido en `orders` (`status = 'pending_payment'`, `utm_source`, `utm_campaign`).
3. **Resolución del Vínculo (`social_inquiries.linked_order_id`):**
   - Al crearse el pedido (o al consultar/vincular desde la bandeja administrativa), toda consulta abierta de `dr-sevilla` con el mismo `email_normalized` (o vinculada manualmente por el operador vía `PATCH /api/v1/admin/inquiries/:inquiry_id`) queda asociada a `orders.id` (`linked_order_id`) y pasa a `followup_status = 'order_created'`.
4. **Cierre del Ciclo (Pago Verificado → Matrícula Moodle):**
   - Cuando `verifyPayment` confirma el abono bancario (`orders.status = 'paid_verified'`) y `confirmEnrollment` registra el alta en Moodle (`orders.status = 'fulfilled'`), la bandeja de seguimiento refleja la conversión completa hasta `enrolled`.

---

## 5. Primer Incremento Implementable (Sujeto a Aprobación)

Antes de construir interfaz web o métricas adicionales, se propone como **Incremento 1** implementar exclusivamente el núcleo de datos y API de la Bandeja de Interesados (`BL-01` + `BL-03` + `BL-04`):

1. **Migración incremental `backend/migrations/005_social_inquiries_followup.sql`:**
   - Creación idempotente (`CREATE TABLE IF NOT EXISTS social_inquiries`) con claves foráneas compuestas hacia `academies(id)`, `products(academy_id, sku)`, `admin_operators(academy_id, operator_id)` y `orders(academy_id, id)`.
2. **Servicio `backend/src/services/social-inquiries.service.js` y rutas en `backend/src/server.js`:**
   - `GET /api/v1/admin/inquiries`: listado priorizado por `next_action_at` / `created_at` con filtros por `followup_status`, `channel`, `interested_sku` y `assigned_operator_id`.
   - `POST /api/v1/admin/inquiries`: registro idempotente de interesado con origen RR. SS., curso de interés, responsable, estado inicial y próxima acción.
   - `PATCH /api/v1/admin/inquiries/:inquiry_id`: actualización auditada de responsable, estado de seguimiento, próxima acción y vinculación con `linked_order_id`.
3. **Sincronización con `CheckoutService` y `AdminOperationsService`:**
   - Vinculación automática opcional por `(academy_id, email_normalized)` al registrar pedido o al confirmar pago/matrícula, sin alterar el contrato público de `POST /api/v1/checkout`.
4. **Pruebas unitarias e integración PostgreSQL:**
   - Cobertura de aislamiento multi-academia, RBAC, validación de los 5 SKUs, rechazo de campos no permitidos y vinculación con pedidos.
