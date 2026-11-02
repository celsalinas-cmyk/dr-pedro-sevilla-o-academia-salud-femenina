# ADR-006 | Separación comercial Academia Mujer Sana / agenda clínica
Fecha: 2026-11-01 | Estado: APROBADO EN PRINCIPIO (asignación de números por confirmar)
## Decisión
Este proyecto se limita al embudo de ventas de los cuatro cursos: TikTok/Instagram -> catálogo -> checkout -> pedido -> conciliación QR -> matrícula Moodle NOVARUM. AVERA Health tiene un flujo médico distinto y queda fuera de alcance; no integrar agendas clínicas, historiales, diagnóstico o telemedicina.
## Canales
Conservar agenda médica y sus contactos existentes, sin rediseñar proceso clínico. En UX mostrar un solo CTA de agenda que lleva a la sección médica. Proponer canal dedicado para dudas de cursos y soporte (78456338) y canal de agenda (69058830), condicionados a confirmación administrativa de propiedad y disponibilidad. No mostrar dos números sin etiquetas en el mismo bloque. Una persona puede operar ambos al inicio.
## UX/CRO
Todos los CTA Comprar curso/pack llevan a un checkout comercial unificado cuando esté funcional; no a WhatsApp. Soporte académico es secundario y no obligatorio para comprar. Simplificar material repetido de fichas. Bloque breve 'Cómo funciona': elegir -> pagar -> acceder a Moodle, sin aparentar activación automática antes de Gate 3. Ningún nuevo formulario clínico.
## Gate 2 dependencias
Backend, almacenamiento, políticas de consentimiento, pago verificado, duración acceso y responsable comercial quedan por definir. No modificar main, no implementar pagos en frontend, no iniciar flujos de AVERA.
## Seguimiento
Registrar decisión en contratos de próxima versión; actualizar copy/CTA en PR de UX por separado de backend.