# ADR-008 — Núcleo B2C reutilizable para academias | Gate 2
Fecha: 2026-11-01 | Estado: DECISIÓN DE ARQUITECTURA APROBADA; implementación PLAN-ONLY
Relacionado: docs/contracts/07-GATE2-CHECKOUT-LEADS-ORDERS.md, ADR-006, Gate 1 PR #1

## Decisión
Diseñar el backend comercial en Google Cloud como núcleo B2C reutilizable para varias academias, pero **implementar y habilitar exclusivamente el tenant dr-sevilla** en el MVP. TechPro y futuras academias son casos de diseño, no entregables, y no deben crearse cuentas ni portales por adelantado.

## Modelo básico de aislamiento
- Entidad tenant/academy: academy_id (identificador interno inmutable), slug, estado, hostname verificado, configuración de marca, entidad cobradora y moneda; MVP solo dr-sevilla.
- products, prices, leads/customers, consents, orders, order_lines, payments, enrollments y audit_events pertenecen a academy_id (según corresponda). IDs de pedido y claves de idempotencia se acotan por academia, con índices/constraints explícitos. No mezclar comunicaciones comerciales ni datos educativos.
- Las identidades globales compartidas entre academias NO se habilitan en MVP; un mismo email puede ser cliente distinto por academia. La unicidad del correo, cuando aplique, es (academy_id, normalized_email).
- academy_id NO se confía al navegador como prueba de autorización. Backend determina tenant mediante hostname/origen registrado y configuración servidor, validando cada request y credenciales administrativas. CORS NO es mecanismo de autorización.
- Toda operación de lectura/escritura, exportación y dashboard debe comprobar tenant en servidor; pruebas negativas de acceso cruzado obligatorias. No usar secret compartido para clientes externos.

## Stack y operación
Web estática Dr Sevilla conserva Hostinger; API propuesta en Google Cloud Run; persistencia en base aislada o esquema con límites fuertes y credenciales mínimas, selección final por ADR de costos/capacidad Cloud SQL y riesgos con NEXUS. No se autoriza modificar recursos NEXUS ni compartir datos con CBN. Secret Manager, Logging con datos minimizados, backup y alertas. No afirmar costo cero.
Frontends de otras academias podrán consumir contratos API versionados a futuro mediante dominios y credenciales habilitados explícitamente. Estrategia multi-tenant debe ser segura antes de exposición pública, pero no requiere admin SaaS.

## Contratos y catálogo
- Checkout recibe sku y contexto de sitio; precio y academy_id se resuelven en servidor. Cliente no decide precio/tenant.
- Una petición de checkout valida consentimiento, identifica/crea lead en academia, crea orden y líneas en una transacción idempotente.
- SKU y precios no se reutilizan entre academias sin namespace o identidad compuesta; pack y curso individual pertenecen al mismo tenant.
- Pagos/QR y matrículas Moodle se desarrollan en Gate 3; cada academia tiene configuración propia de cuenta receptora, política de devolución y mapa Moodle; sin compartir tokens.
- UTM se conserva por orden y evento, no se mezcla entre tenants.

## Seguridad / QA requerida
Pruebas cross-tenant obligatorias con tenant ficticio en test: acceder/editar órdenes, reutilizar tokens, alterar academy_id, saltar hostname o cambiar SKU; denegar todas las acciones fuera de tenant. Rate limits por tenant más controles por IP/endpoint, privacidad, idempotencia y auditoría. Si no existe mecanismo confiable de resolución tenant, bloquear endpoint.
No usar síntomas, diagnóstico, historial clínico, respuestas de autoevaluación ni datos AVERA en CRM comercial.

## Scope estricto
Gate 2: entidad academia, productos, catálogo de precios, lead y consentimientos, checkout, pedidos persistidos, pipeline/dash mínimo para Dr Sevilla y seguridad tenant-aware.
NO incluido: onboarding self-service, roles personalizables por academia, portal multitenant, facturación SaaS, cobros reales, matrícula automatizada, integraciones Manychat profundas, NOVAFORGE Texas B2B, configuración operativa de TechPro.

## Gates
G2-P: comparar Google Cloud Run y alternativas de DB/costos, diagramas, seguridad tenant, UX checkout, contrato API; presentar ADR para aprobar antes de codificar.
G2-A: pruebas de Dr Sevilla + test de aislamiento con segundo tenant sintético, sin crear segundo cliente real.
G2-EXIT: QA independiente evidencia privacidad, idempotencia, precios por servidor, no cross-tenant; PR revisado. Merge y deploy requieren autorización separada.

## Instrucción a Antigravity
Leer 00..08; adaptar el diseño Gate 2-P sobre Google Cloud Run con esta capacidad multi-academia mínima, sin construir una plataforma SaaS ni reescribir Gate 1. Presentar modelo lógico, costos, API, transacción, pruebas, riesgos y decisiones bloqueantes. PLAN-ONLY: no código, recursos cloud, merge ni deploy.
