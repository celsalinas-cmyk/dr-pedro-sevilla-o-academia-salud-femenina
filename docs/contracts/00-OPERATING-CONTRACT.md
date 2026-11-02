# Dr. Pedro Sevilla | Contrato maestro de implementación v1.0
Estado: DRAFT / pendiente de aprobación comercial y técnica. Fecha: 2026-11-01.
Fuente de verdad: este repositorio. Rama de documentación: docs/commerce-contracts-v1. Producción: main sin cambios.

## Objetivo / KPI
Convertir tráfico TikTok/Instagram a leads identificados, pedidos pagados y matrículas correctas en Moodle NOVARUM. KPIs: visitas etiquetadas, reproducciones de muestra, leads con consentimiento, pedidos, pagos conciliados, matrículas exitosas, conversiones, tasa paquete, errores y tiempo de activación. Ningún KPI inventado.

## Contexto confirmado
Web pública pedrosevilla.novaforge.group, implementación HTML/CSS/JS simple; repositorio actual contiene index.html y css/styles.css. Formulario existente tiene action="TU_SCRIPT_URL_AQUI" y NO captura confirmada. Moodle propio cloud.novarum.com.bo, sin configuración API verificada. Cuatro temas: Endometriosis, Vaginosis, SOP, Aprende Mujer (microbiota/ecosistema vaginal). No están confirmados IDs Moodle, archivos MP4 de vista previa, cuenta bancaria ni proveedor de pagos.

## Oferta propuesta (PENDIENTE aprobación)
Lección inicial gratuita sin login; cursos completos individuales Bs 59; pack de cuatro Bs 149; condiciones de acceso, impuestos, política de reembolso y propietario de cobro a definir. Nunca mostrar precio como final ni cobrar antes de aprobación. No confundir video gratis con curso completo gratis.

## In scope MVP
1. Conservar estética y estructura de la web actual y atención médica existente.
2. Sección comercial mobile-first con cuatro productos, descripción aprobada, vista previa gratuita solo si archivo autorizado, botones de compra individual/pack y etiquetas UTM.
3. Captación real de consentimiento y pedido; identificador único de lead/pedido; deduplicación; protección antispam.
4. Pago QR inicialmente con conciliación humana comprobada (nunca confiar solo en captura); estados auditables.
5. Alta/matrícula Moodle por operador como fallback si API aún no habilitada; integración automatizada en fase posterior tras prueba y permisos.
6. Dashboard simple y exportación CSV sin datos clínicos.
7. Logs de eventos sin secretos ni información médica.

## Out of scope MVP
Cambiar Moodle core; construir CRM universal; automatización masiva de comentarios TikTok; mensajería sin opt-in; campañas pagadas; pasarela propia; suscripciones; cupones complejos; telemedicina; almacenar diagnóstico/síntomas; reescribir sitio a framework o cambiar hosting.

## Reglas Codex obligatorias
- NO programar ni tocar main antes de aprobación explícita de contratos y gates.
- Trabajar solo en rama feature basada en main; PR y revisión humana. No hacer deploy automático ni merge.
- Contratos antes que código: pedir ADR para nuevas dependencias, infraestructura, datos o cambios de alcance.
- Inspeccionar GitHub actual, no reemplazar index.html a ciegas.
- No credenciales, QR estático bancario sensible, claves Moodle o tokens de terceros en front-end/GitHub.
- Cambios pequeños, reversibles, probados, con evidencia, checklist y rollback; nada de parches encadenados.
- Si la especificación es ambigua: bloquear la acción afectada, documentar supuesto y seguir con lo independiente.
- La web no debe registrar pagos exitosos desde eventos de navegador ni habilitar contenido por frontend.
- No inventar testimonios, certificaciones, promesas clínicas, precios aprobados o cantidades.
- Cada PR documentará requisitos cubiertos, pruebas realizadas, riesgos y elementos pendientes.

## Roles
Arquitectura/product owner: aprueba contratos, alcance, copy y gates. Codex: implementador senior bajo contrato. Revisor QA independiente: verifica tests, seguridad, no regresión y trazabilidad. Operador comercial: conciliación y resolución de incidencias. Responsable clínico: aprueba contenido y disclaimer. Ningún rol puede autoaprobar sus excepciones.

## Gates
G0: catálogo, precios, video, responsables, condiciones, hosting/backend, tratamiento de datos aprobados.
G1: diseño y páginas navegables en staging; no tocar rutas médicas; responsive/accesibilidad.
G2: backend guarda lead y pedido de prueba, consentimientos y UTM, sin duplicación; falla segura.
G3: conciliación real/verificable y matrículas correctas en prueba; casos negativos y rollback.
G4: prueba E2E móvil TikTok→web→pedido→pago→Moodle y observabilidad; checklist firmado; PR listo para aprobar.
Ningún gate pasa por capturas bonitas únicamente.

## Pendientes bloqueantes
Confirmar primer video gratuito por curso / archivo y licencias; nombres definitivos/temarios/duración de los cuatro cursos; IDs Moodle y servicios web; hosting de backend/base de datos; titular comercial e impuesto/facturación; QR y conciliación; distribución de ingresos y política de reembolso; cláusula de consentimiento; dominio de staging; acceso y vigencia de Moodle.
