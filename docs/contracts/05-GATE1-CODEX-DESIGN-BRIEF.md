# Gate 1 — Orden de diseño y análisis para Codex
Fecha: 2026-11-01 | Estado: PLAN-ONLY | No autoriza escritura de código, merge ni despliegue.

## Contexto
Leer primero docs/contracts/00-OPERATING-CONTRACT.md, 01-FUNCTIONAL-AND-COMMERCE.md, 02-TECHNICAL-DATA-SECURITY.md, 03-GATES-QA-CODEX.md y 04-GATE0-DECISION-REGISTER.md. Analizar el estado real de index.html y css/styles.css en main. La web existente pedrosevilla.novaforge.group conserva identidad, agenda y Academia Farma.

## Producto
Cuatro cursos completos pagos: Endometriosis, Vaginosis, SOP y Aprende Mujer. Precios propuestos Bs 79 individual, Bs 199 por pack, a confirmar antes de publicarse como ventas reales. SIN videos de curso gratuitos. Cada tarjeta detalla: objetivo educativo sin promesas clínicas, video ~10 min, recurso SCORM, infografía, presentación/PDF, autoevaluación educativa. No diagnosticar. Consulta médica opcional e independiente.

## Requerimientos de propuesta Gate 1
REQ-01: jerarquía mobile-first: imagen/confianza del doctor, CTA 'Explorar los cursos' anclado en #cursos.
REQ-02: cuatro fichas visibles y diferenciadas; textos sujetos a aprobación clínica. Aclarar distinción Vaginosis / Aprende Mujer.
REQ-03: paquete destacado con cálculo veraz Bs 316 versus Bs 199 (si se aprueban precios) y descuento 37% redondeado.
REQ-04: 'Qué incluye' común y FAQ (modalidad, contenido, acceso, evaluación, consulta separada, soporte). No certificar sin evidencia.
REQ-05: propuestas de CTA de compra en staging NO funcionales, señalizadas como no disponibles; no simular recepción de pago.
REQ-06: no conectar el formulario existente a URL placeholder; proponer solución Gate 2, no mostrar éxito falso. No romper contacto/agenda.
REQ-07: semántica/accesibilidad, contraste, teclado, diseño 360/768/1440, rendimiento razonable y estilos coherentes.
REQ-08: UTMs previstos en especificación (no capturar datos sin backend y consentimiento).
REQ-09: mantener HTML/CSS/JS sin añadir framework por defecto. No introducir bibliotecas ni plataformas sin ADR.

## Lo que Codex entregará AHORA (solo análisis, sin commits)
1. Inventario del DOM/estilos existentes y riesgos de regresión.
2. Wireframe textual móvil y desktop y orden de secciones, con propuestas de copy para revisión.
3. Lista exacta de archivos que cambiaría y componentes, más diffs conceptuales.
4. Matriz REQ -> archivo -> caso de prueba -> evidencia.
5. Accesibilidad, rendimiento, riesgos y rollback.
6. Lista de información faltante que no bloquea el mockup y bloqueadores reales para habilitar checkout.

## Criterios para autorizar implementación de Gate 1 más adelante
Revisión humana de wireframe y copy; confirmación de precio publicable, modalidad/acceso y política de mensajes; plan de QA aprobado. Entonces crear rama feature independiente y abrir PR. No tocar main sin revisión, nunca asumir pagos reales.

## Prompt literal para Codex
Lee íntegramente docs/contracts/00-OPERATING-CONTRACT.md a 04-GATE0-DECISION-REGISTER.md y esta orden. Tu tarea actual es exclusivamente análisis y diseño de Gate 1. Inspecciona index.html y css/styles.css. Propón un plan mínimo, wireframe responsivo, copy del catálogo, matriz de trazabilidad y pruebas. No escribas código, no cambies archivos, no commits, no PR, no deploy. Señala riesgos y decisiones abiertas. No inventes assets, tokens, URLs, pagos ni funcionalidades. Detente y solicita aprobación del plan.
