# NOVARUM Commerce Engine - Backend Core (Gate 2-A1)

Motor comercial transaccional e idempotente para venta de cursos y paquetes educativos.
Primer tenant en producción: **Dr. Pedro Sevilla — Academia Mujer Sana** (`dr-sevilla`).

---

## 1. Requisitos Previos

- **Node.js**: v20.x o superior (`node -v`)
- **npm**: v10.x o superior (`npm -v`)

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
   - `DATABASE_URL`: Cadena de conexión PostgreSQL (ej. `postgresql://postgres:password@localhost:5432/novarum_b2c_commerce`).
   - `ALLOWED_ORIGINS`: `https://pedrosevilla.novaforge.group,http://127.0.0.1:3000`.
   - `PORT`: `3000`.

---

## 3. Ejecución de Migraciones

Para inicializar las tablas maestras y las semillas de `dr-sevilla` en una instancia PostgreSQL:
```bash
npm run migrate
```

Las migraciones aplican:
- `migrations/001_initial_schema.sql`: Tablas `academies`, `products`, `prices`, `leads`, `consents`, `orders`, `order_items`, `order_events` con claves foráneas compuestas estrictas `(academy_id, ...)` que impiden cualquier referencia foránea cruzada entre academias.
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

El proyecto cuenta con dos niveles de pruebas rigurosamente separados:

### A. Pruebas Unitarias Rápidas (`npm run test:unit`)
Pruebas ejecutadas con `pg-mem` para validación rápida en memoria:
- `tests/checkout.test.js`: Validación de precios server-side, reintentos idempotentes (200 OK), conflicto de payload (409 Conflict), control de concurrencia y validación estricta de schema (Data Minimization).
- `tests/isolation.test.js`: Aislamiento multi-tenant por `academy_id`, clientes independientes con mismo email y protección de tokens opacos.

### B. Pruebas de Integración sobre PostgreSQL Real (`npm run test:integration`)
Pruebas ejecutadas contra un cluster PostgreSQL 18 real desechable provisionado localmente:
- `tests/real-postgres.test.js`:
  1. **Concurrencia real (10 solicitudes paralelas):** 10 solicitudes concurrentes con la misma `idempotency_key` ejecutadas sobre PostgreSQL real. Da exactamente **1 orden creada (201 Created)**, **9 respuestas idempotentes (200 OK)** y **cero registros huérfanos**.
  2. **Verificación de Rollback:** Fallo deliberado de SKU durante la transacción ejecuta rollback limpio; confirma que no se persisten leads, consentimientos ni órdenes parciales.
  3. **Integridad Multi-Academia con FKs Compuestas:** Intento de insertar ítems o pedidos apuntando a registros de otra academia es bloqueado a nivel de motor PostgreSQL (`SQLSTATE 23503`).
  4. **Seguridad de Errores y Sanitización HTTP 500:** Fallos de base de datos responden con un mensaje seguro y genérico `INTERNAL_SERVER_ERROR`, registrando el error internamente sin filtrar sentencias SQL, contraseñas o detalles de infraestructura al cliente.

### C. Ejecutar Todas las Pruebas
```bash
npm run test:all
```
Total: **16 pruebas (16/16 PASS)**.
