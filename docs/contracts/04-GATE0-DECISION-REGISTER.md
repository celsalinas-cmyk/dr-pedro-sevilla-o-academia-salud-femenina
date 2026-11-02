# Gate 0 — Registro de decisiones y autorizaciones
Fecha: 2026-11-01 | Estado: EN REVISIÓN | Contratos: v1.0
Este documento NO autoriza implementación de código ni despliegue.

## Decisiones confirmadas por el propietario del proyecto
- [x] Preservar web existente pedrosevilla.novaforge.group y su repo GitHub.
- [x] Mantener Moodle propio cloud.novarum.com.bo como sistema académico.
- [x] Catálogo con 4 temas: Endometriosis, Vaginosis, SOP, Aprende Mujer (ecosistema vaginal).
- [x] Vender curso individual o paquete de 4.
- [x] NO regalar ningún video de los cursos; la captación se apoya en lives, podcasts y publicaciones ya disponibles en redes.
- [x] Oferta comercial preferida: Bs 79 por curso y Bs 199 por paquete de cuatro (confirmar antes de cobro real).
- [x] Controlar desarrollo con contratos, gates, ramas y QA; no permitir cambios arbitrarios de Codex.

## Hipótesis de implementación: no se han aprobado como hechos
- [ ] Confirmación comercial final de Bs 79 individual y Bs 199 pack, titular comercial y margen.
- [x] Sin videos gratuitos de los cursos en web; material orgánico social permanece fuera del contenido de pago.
- [ ] Verificar nombres finales, contenidos y duración de los 4 cursos, video ~10 min + SCORM + infografía + PDF/presentación + evaluación educativa.
- [ ] Identificadores de cursos Moodle, entorno de prueba y política de acceso.
- [ ] Método de pago QR, cuenta receptora, procedimiento de conciliación y responsable.
- [ ] Quién factura, términos, privacidad, reembolsos y duración del acceso.
- [ ] Arquitectura y hospedaje del backend/DB; verificar capacidades Hostinger actuales.
- [ ] Aprobación clínica de fichas y claims educativos.

## Riesgo existente confirmado en el repositorio
index.html contiene form#leadForm action="TU_SCRIPT_URL_AQUI"; el script no implementa persistencia. No promocionar ese formulario como captación operativa hasta corregir y probar. La navegación médica existente debe mantenerse.

## Disociación de gates
G1 puede desarrollarse tras aprobación limitada de diseño, catálogo y textos: botones de compra en staging quedan explícitamente deshabilitados hasta backend + pago. NO mostrar compra funcional ni capturar leads en un formulario falso.
G2 requiere selección de backend/DB, términos y consentimiento.
G3 requiere QR conciliable, operador y configuración Moodle verificadas.
G4 requiere pruebas end-to-end y autorización expresa para despliegue.

## Orden de trabajo siguiente
1. Product owner revisa decisiones pendientes y aprueba alcance G1.
2. Arquitecto crea matriz de trazabilidad REQ->archivo->test y ADR cuando corresponda.
3. Codex inspecciona index.html y css/styles.css; presenta plan sin escribir código.
4. QA valida plan; Codex implementa en rama feature independiente solo tras autorización.
5. Pull request, pruebas y revisión antes de merge; main permanece intacta.

## Criterios de salida Gate 0
Decisiones y responsables identificados, alcance y fuera de alcance confirmados, supuestos señalados, criterios verificables aceptados y riesgos P0 con plan. Estado actual: PARTIAL, Gate 0 NO PASS.