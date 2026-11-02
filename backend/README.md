# NOVARUM Commerce Engine - Backend Core (Gate 2-A1)

Motor comercial transaccional e idempotente para venta de cursos y paquetes educativos.
Primer tenant en producción: **Dr. Pedro Sevilla — Academia Mujer Sana** (`dr-sevilla`).

---

## 1. Requisitos Previos

- **Node.js**: v20.x o superior (`node -v`)
- **npm**: v10.x o superior (`npm -v`)
- **PostgreSQL**: v15.x o superior (o Docker) para ejecución con base de datos real.
  *Para testing unitario y de concurrencia, el proyecto incluye entorno in-memory con `pg-mem` sin dependencias externas.*

---

## 2. Instalación y Configuración Local

1. Ingresar al directorio `backend`:
   ```bash
   cd backend
   ```

2. Instalar dependencias:
   ```bash
   npm install
   ```

3. Configurar variables de entorno:
   Copiar `.env.example` a `.env`:
   ```bash
   cp .env.example .env
   ```

   Variables clave:
   - `DEFAULT_ACADEMY_ID`: `dr-sevilla` (inyección autoritativa en backend; zero-trust al navegador).
   - `DATABASE_URL`: Cadena de conexión PostgreSQL (ej. `postgresql://postgres:postgres@localhost:5432/novarum_b2c_commerce`).
   - `ALLOWED_ORIGINS`: `https://pedrosevilla.novaforge.group,http://127.0.0.1:3000`.
   - `PORT`: `3000`.

---

## 3. Ejecución de Migraciones

Para inicializar las tablas maestras y las semillas de `dr-sevilla` en una instancia PostgreSQL:
```bash
npm run migrate
```

Las migraciones aplican:
- `migrations/001_initial_schema.sql`: Tablas `academies`, `products`, `prices`, `leads`, `consents`, `orders`, `order_items`, `order_events` con constraints atómicos e índices compuestos por `academy_id`.
- `migrations/002_seed_dr_sevilla.sql`: Configuración de tenant `dr-sevilla`, 5 productos formativos y catálogo de precios inmutables (Bs 79 individual / Bs 199 pack).

---

## 4. Ejecución del Servidor Local

```bash
npm start
```
El servidor quedará disponible en `http://127.0.0.1:3000` con los siguientes endpoints:
- `GET /health` -> Estado del servicio y tenant activo.
- `POST /api/v1/checkout` -> Creación transaccional e idempotente de pedidos.
- `GET /api/v1/orders/:opaque_token/status` -> Consulta pública segura (Zero PII).

---

## 5. Ejecución de la Suite de Pruebas Automatizadas

```bash
npm test
```

La suite cubre 11 pruebas automatizadas estructuradas en dos suites principales:

### Suite 1: Checkout & Idempotency (`tests/checkout.test.js`)
1. **Precios Server-Side:** Creación de pedido con precio inmutable de base de datos (`Bs 199` para el pack de cuatro cursos).
2. **Reintento Idempotente:** Envío idéntico con la misma `idempotency_key` devuelve el pedido original (`200 OK`) sin duplicar.
3. **Conflicto de Idempotencia:** Reutilización de `idempotency_key` con payload modificado responde `HTTP 409 Conflict (IDEMPOTENCY_PAYLOAD_MISMATCH)` sin alterar registros.
4. **Concurrencia Atómica:** 5 peticiones simultáneas paralelas resultan en exactamente 1 orden creada (`201 Created`) y 4 reintentos (`200 OK`). 0 registros duplicados en base de datos.
5. **Minimización de Datos:** Rechazo con `HTTP 422` ante nombres inválidos, correos mal formateados o términos no aceptados; `HTTP 404` ante SKUs no catalogados.
6. **Zero PII:** Verificación de que la consulta de estado expone solo `order_number`, `status`, `sku` e importe, sin datos personales.

### Suite 2: Multi-Tenant Isolation (`tests/isolation.test.js`)
1. **Rechazo de Producto Ajeno:** El servicio `dr-sevilla` rechaza comprar productos de otro tenant con `HTTP 404 (PRODUCT_NOT_FOUND)`.
2. **Leads Aislados:** Clientes con el mismo correo electrónico en distintas academias generan registros de lead completamente independientes mediante `UNIQUE (academy_id, email_normalized)`.
3. **Tokens Criptográficos Aislados:** Un tenant no puede consultar ni inferir órdenes de otra academia mediante su `opaque_token` (`HTTP 404`).

---

## 6. Compatibilidad con Google Cloud Run

El código fuente es totalmente stateless y modular:
- Sin almacenamiento en disco local ni variables de estado en memoria.
- Resuelve `academy_id` mediante variables seguras de entorno inyectadas por Secret Manager.
- Logs estructurados con serializadores que eliminan PII automáticamente.
- Listo para ser empaquetado en contenedor Docker estándar.
