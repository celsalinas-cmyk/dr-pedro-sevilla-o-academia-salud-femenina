# ADR-009 — Corrección de dominio y resolución QA Gate 2-P
Fecha: 2026-11-01 | Estado: DECISIONES APROBADAS PARA ACTUALIZAR DISEÑO / PLAN-ONLY

## Dominio canónico confirmado por Product Owner
**https://pedrosevilla.novaforge.group** (grafía exacta: sevilla).
Sustituye referencias anteriores a drpedrosevilla.com, pedrosevilla.novaforge.group y otros nombres propuestos en documentos de arquitectura Gate 2. La ruta pública y TLS deben ser comprobados por el implementador antes de configurar CORS u orígenes de producción. El origen de staging no está confirmado: no inventarlo.

## Aprobación de observaciones QA
Se aceptan las restantes observaciones del QA de Gate 2-P:
1. Resolución de tenant desde configuración confiable del backend. No tratar Origin/Host, que puede enviar cualquier cliente, como autorización de tenant. CORS no es autorización.
2. Costos Cloud Run, Cloud SQL, storage, backup y networking a revisar con cifras verificadas; no asumir presupuesto de USD 10–14 ni costo cero.
3. Idempotencia: clave+payload iguales retornan pedido original; misma clave con payload distinto => HTTP 409 sin efectos secundarios. Concurrencia y restricciones DB.
4. Recuperación de fallos: reintentos seguros, expiración de pedidos, pérdida de respuesta, errores de infraestructura y auditoría.
5. Constraints de academy_id y pruebas cross-tenant (incluyendo hostname spoofing).
6. La implementación sigue limitada a dr-sevilla; AVERA/NEXUS/TechPro no se modifican.

## Gate
Esta aceptación autoriza **actualizar el diseño y ADR de Gate 2-P**, NO autoriza escribir código, recursos GCP, merge a main, cobros, configuración bancaria ni despliegue. Ante discrepancias en los contratos antiguos, prevalece esta corrección para el dominio. Solicitar revisión del ADR técnico consolidado para concluir Gate 2-P.
