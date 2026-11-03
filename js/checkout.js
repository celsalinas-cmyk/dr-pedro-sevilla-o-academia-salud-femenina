/**
 * checkout.js - NOVARUM Commerce Engine - Gate 2-A2
 * Unified Commercial Checkout UI & Client Flow
 * 
 * Features:
 * 1. Unified checkout modal for all 5 catalog products (4 single courses + 1 pack).
 * 2. Strict client-side validation mirroring server contracts.
 * 3. Client-generated UUID idempotency key preserved across network retries.
 * 4. Automatic capture and retention of UTM parameters (TikTok, Instagram, etc.).
 * 5. Double-click prevention and loading state indicators.
 * 6. Resilient network error handling with retry capability.
 * 7. Server-authoritative confirmation with zero PII exposure.
 * 8. Real-time order status check via opaque token.
 */

(function () {
  'use strict';

  // 1. Official Catalog Definitions
  const PRODUCTS = {
    'mujer-informada-4': {
      sku: 'mujer-informada-4',
      title: 'Pack Completo: Mujer Informada (4 Cursos)',
      tag: 'Pack Integral · 4 Cursos',
      priceFormatted: 'Bs 199',
      priceMinor: 19900,
      currency: 'BOB',
    },
    'endometriosis': {
      sku: 'endometriosis',
      title: 'Curso: Endometriosis (Del Dolor a la Comprensión)',
      tag: 'Curso Individual',
      priceFormatted: 'Bs 79',
      priceMinor: 7900,
      currency: 'BOB',
    },
    'vaginosis': {
      sku: 'vaginosis',
      title: 'Curso: Vaginosis Bacteriana (Reconocimiento y Cuidados)',
      tag: 'Curso Individual',
      priceFormatted: 'Bs 79',
      priceMinor: 7900,
      currency: 'BOB',
    },
    'sop': {
      sku: 'sop',
      title: 'Curso: Síndrome de Ovario Poliquístico (SOP)',
      tag: 'Curso Individual',
      priceFormatted: 'Bs 79',
      priceMinor: 7900,
      currency: 'BOB',
    },
    'aprende-mujer': {
      sku: 'aprende-mujer',
      title: 'Curso: Aprende Mujer (Microbiota y pH)',
      tag: 'Curso Individual',
      priceFormatted: 'Bs 79',
      priceMinor: 7900,
      currency: 'BOB',
    },
  };

  // State
  let currentSku = 'mujer-informada-4';
  let currentIdempotencyKey = null;
  let currentOpaqueToken = null;
  let isSubmitting = false;

  // Determine API base URL
  const API_BASE = window.NOVARUM_API_BASE !== undefined 
    ? window.NOVARUM_API_BASE 
    : '';

  // 2. UTM Capture and Persistence
  function getSanitizedUtm() {
    const sanitizeParam = (val) => {
      if (!val || typeof val !== 'string') return null;
      const clean = val.replace(/[^a-zA-Z0-9_-]/g, '').trim().slice(0, 64);
      return clean.length > 0 ? clean : null;
    };

    // First check URL query params
    const params = new URLSearchParams(window.location.search);
    const source = sanitizeParam(params.get('utm_source'));
    const medium = sanitizeParam(params.get('utm_medium'));
    const campaign = sanitizeParam(params.get('utm_campaign'));
    const content = sanitizeParam(params.get('utm_content'));

    let utm = null;
    if (source || medium || campaign || content) {
      utm = {};
      if (source) utm.source = source;
      if (medium) utm.medium = medium;
      if (campaign) utm.campaign = campaign;
      if (content) utm.content = content;
      try {
        sessionStorage.setItem('novarum_utm', JSON.stringify(utm));
      } catch (_) {}
    } else {
      // Fallback to session storage if previously captured
      try {
        const stored = sessionStorage.getItem('novarum_utm');
        if (stored) {
          utm = JSON.parse(stored);
        }
      } catch (_) {}
    }
    return utm;
  }

  // 3. UUID Generator for Idempotency
  function generateUUID() {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) {
      return crypto.randomUUID();
    }
    // RFC4122 compliant fallback
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
      const r = (Math.random() * 16) | 0;
      const v = c === 'x' ? r : (r & 0x3) | 0x8;
      return v.toString(16);
    });
  }

  // 4. DOM Elements
  let backdrop, modal, closeBtn, formContainer, confirmationContainer;
  let form, nameInput, emailInput, phoneInput, termsCheckbox, marketingCheckbox;
  let skuSelect, productTag, productTitle, productSku, productPrice, submitBtn, submitBtnPrice;
  let alertBox, alertTitle, alertMessage, retryBtn;
  let confirmedOrderNumber, confirmedProductTitle, confirmedTotalAmount, confirmedStatusBadge, confirmedExpiresAt;
  let btnCheckStatus, statusLookupFeedback, btnWhatsappPayment, btnCloseConfirmation;

  function initElements() {
    backdrop = document.getElementById('checkout-modal-backdrop');
    modal = document.getElementById('checkout-modal');
    closeBtn = document.getElementById('btn-close-checkout');
    formContainer = document.getElementById('checkout-form-container');
    confirmationContainer = document.getElementById('checkout-confirmation-container');

    form = document.getElementById('checkout-form');
    nameInput = document.getElementById('checkout-name');
    emailInput = document.getElementById('checkout-email');
    phoneInput = document.getElementById('checkout-phone');
    termsCheckbox = document.getElementById('consent-terms');
    marketingCheckbox = document.getElementById('consent-marketing');

    skuSelect = document.getElementById('checkout-sku-select');
    productTag = document.getElementById('checkout-product-tag');
    productTitle = document.getElementById('checkout-product-title');
    productSku = document.getElementById('checkout-product-sku');
    productPrice = document.getElementById('checkout-product-price');
    submitBtn = document.getElementById('btn-submit-order');
    submitBtnPrice = document.getElementById('submit-btn-price');

    alertBox = document.getElementById('checkout-error-alert');
    alertTitle = document.getElementById('alert-title');
    alertMessage = document.getElementById('alert-message');
    retryBtn = document.getElementById('btn-retry-checkout');

    confirmedOrderNumber = document.getElementById('confirmed-order-number');
    confirmedProductTitle = document.getElementById('confirmed-product-title');
    confirmedTotalAmount = document.getElementById('confirmed-total-amount');
    confirmedStatusBadge = document.getElementById('confirmed-status-badge');
    confirmedExpiresAt = document.getElementById('confirmed-expires-at');

    btnCheckStatus = document.getElementById('btn-check-order-status');
    statusLookupFeedback = document.getElementById('status-lookup-feedback');
    btnWhatsappPayment = document.getElementById('btn-whatsapp-payment');
    btnCloseConfirmation = document.getElementById('btn-close-confirmation');
  }

  // 5. Update Product Display in Modal
  function setProduct(sku) {
    if (!PRODUCTS[sku]) {
      sku = 'mujer-informada-4';
    }
    currentSku = sku;
    const prod = PRODUCTS[sku];

    if (productTag) productTag.textContent = prod.tag;
    if (productTitle) productTitle.textContent = prod.title;
    if (productSku) productSku.textContent = `SKU: ${prod.sku}`;
    if (productPrice) productPrice.textContent = prod.priceFormatted;
    if (submitBtnPrice) submitBtnPrice.textContent = prod.priceFormatted;
    if (skuSelect && skuSelect.value !== sku) {
      skuSelect.value = sku;
    }
  }

  // 6. Modal Open & Close Logic
  function openCheckout(sku) {
    if (!backdrop || !modal) return;
    setProduct(sku || currentSku);

    // Generate a fresh idempotency key for this new purchase intent
    currentIdempotencyKey = generateUUID();
    clearAlert();
    clearErrors();

    // Show form, hide confirmation
    if (formContainer) formContainer.hidden = false;
    if (confirmationContainer) confirmationContainer.hidden = true;
    if (statusLookupFeedback) statusLookupFeedback.hidden = true;

    backdrop.hidden = false;
    document.body.style.overflow = 'hidden';

    // Focus first input
    setTimeout(() => {
      if (nameInput) nameInput.focus();
    }, 100);
  }

  function closeCheckout() {
    if (!backdrop) return;
    backdrop.hidden = true;
    document.body.style.overflow = '';
    clearAlert();
  }

  // 7. Error & Alert Handlers
  function showAlert(title, message, showRetry = false) {
    if (!alertBox) return;
    if (alertTitle) alertTitle.textContent = title;
    if (alertMessage) alertMessage.textContent = message;
    if (retryBtn) retryBtn.hidden = !showRetry;
    alertBox.hidden = false;
  }

  function clearAlert() {
    if (alertBox) alertBox.hidden = true;
  }

  function clearErrors() {
    const errors = document.querySelectorAll('.form-error');
    errors.forEach(el => el.hidden = true);
    const inputs = document.querySelectorAll('.form-input, .consent-checkbox');
    inputs.forEach(el => el.classList.remove('input-invalid'));
  }

  // 8. Field Validation (Client-Side)
  function validateForm() {
    clearErrors();
    let isValid = true;

    // Name: 2-80 chars, letters & accents
    const nameVal = nameInput ? nameInput.value.trim() : '';
    const nameRegex = /^[a-zA-ZáéíóúÁÉÍÓÚñÑüÜ\s'-]+$/;
    if (nameVal.length < 2 || nameVal.length > 80 || !nameRegex.test(nameVal)) {
      if (nameInput) nameInput.classList.add('input-invalid');
      const err = document.getElementById('name-error');
      if (err) err.hidden = false;
      isValid = false;
    }

    // Email: valid email, max 100
    const emailVal = emailInput ? emailInput.value.trim() : '';
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (emailVal.length === 0 || emailVal.length > 100 || !emailRegex.test(emailVal)) {
      if (emailInput) emailInput.classList.add('input-invalid');
      const err = document.getElementById('email-error');
      if (err) err.hidden = false;
      isValid = false;
    }

    // Phone: optional, but if present must be 7-15 digits
    const phoneVal = phoneInput ? phoneInput.value.trim() : '';
    if (phoneVal.length > 0) {
      const phoneRegex = /^\+?[0-9]{7,15}$/;
      if (!phoneRegex.test(phoneVal)) {
        if (phoneInput) phoneInput.classList.add('input-invalid');
        const err = document.getElementById('phone-error');
        if (err) err.hidden = false;
        isValid = false;
      }
    }

    // Terms: must be checked
    if (termsCheckbox && !termsCheckbox.checked) {
      const err = document.getElementById('terms-error');
      if (err) err.hidden = false;
      isValid = false;
    }

    return isValid;
  }

  // 9. Process Checkout Submission
  async function submitCheckout() {
    if (isSubmitting) return;

    if (!validateForm()) {
      showAlert('Datos incompletos', 'Por favor revisa los campos señalados en rojo para continuar.');
      return;
    }

    clearAlert();
    setSubmittingState(true);

    const payload = {
      sku: currentSku,
      name: nameInput.value.trim(),
      email: emailInput.value.trim(),
      phone: phoneInput.value.trim() || undefined,
      terms_accepted: termsCheckbox.checked,
      marketing_opt_in: marketingCheckbox ? marketingCheckbox.checked : false,
      privacy_version: 'v1.0',
      idempotency_key: currentIdempotencyKey,
      utm: getSanitizedUtm() || undefined,
    };

    try {
      const response = await fetch(`${API_BASE}/api/v1/checkout`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
        },
        body: JSON.stringify(payload),
      });

      const data = await response.json().catch(() => null);

      if (!response.ok) {
        if (response.status === 429) {
          showAlert('Límite de solicitudes', 'Demasiados intentos. Por favor espera unos momentos antes de reintentar.');
        } else if (response.status === 409) {
          // Re-generate key on conflicting payload
          currentIdempotencyKey = generateUUID();
          showAlert('Conflicto de pedido', 'Se detectó un cambio en los datos del pedido. Se ha actualizado la sesión. Por favor reintenta ahora.', true);
        } else {
          const errMsg = data && data.message ? data.message : 'No fue posible registrar el pedido. Intenta nuevamente.';
          showAlert('Error en el registro', errMsg, true);
        }
        setSubmittingState(false);
        return;
      }

      // Successful order creation (HTTP 201) or idempotent replay (HTTP 200)
      handleCheckoutSuccess(data);
    } catch (networkErr) {
      console.warn('[Checkout] Network error:', networkErr);
      // Retain the exact same idempotency_key for safe retry without duplicate charge
      showAlert(
        'Sin conexión al servidor',
        'No pudimos conectar con el servidor comercial. Tu clave de pedido está protegida. Haz clic en "Reintentar" para reanudar.',
        true
      );
      setSubmittingState(false);
    }
  }

  function setSubmittingState(loading) {
    isSubmitting = loading;
    if (!submitBtn) return;
    submitBtn.disabled = loading;
    const btnText = submitBtn.querySelector('.btn-text');
    const btnSpinner = submitBtn.querySelector('.btn-spinner');
    if (loading) {
      if (btnText) btnText.textContent = 'Procesando pedido seguro...';
      if (btnSpinner) btnSpinner.hidden = false;
    } else {
      const prod = PRODUCTS[currentSku];
      if (btnText) btnText.innerHTML = `Confirmar Pedido — <span id="submit-btn-price">${prod.priceFormatted}</span>`;
      if (btnSpinner) btnSpinner.hidden = true;
    }
  }

  // 10. Display Confirmation State (Zero PII)
  function handleCheckoutSuccess(orderData) {
    setSubmittingState(false);
    currentOpaqueToken = orderData.opaque_token;

    // Hide form, show confirmation
    if (formContainer) formContainer.hidden = true;
    if (confirmationContainer) confirmationContainer.hidden = false;

    // Render Order Details safely without displaying customer PII
    if (confirmedOrderNumber) {
      confirmedOrderNumber.textContent = orderData.order_number || 'DPS-XXXXX';
    }
    const prod = PRODUCTS[currentSku] || PRODUCTS['mujer-informada-4'];
    if (confirmedProductTitle) {
      confirmedProductTitle.textContent = prod.title;
    }
    if (confirmedTotalAmount) {
      const amountMajor = (orderData.total_amount_minor / 100).toFixed(2);
      confirmedTotalAmount.textContent = `Bs ${amountMajor} ${orderData.currency || 'BOB'}`;
    }
    if (confirmedStatusBadge) {
      const statusMap = {
        'pending_payment': 'Pendiente de Pago (Asistido)',
        'paid_verified': 'Pago Verificado en Banco',
        'enrollment_pending': 'Matrícula en Trámite',
        'fulfilled': 'Matriculado',
        'expired': 'Expirado',
      };
      confirmedStatusBadge.textContent = statusMap[orderData.status] || orderData.status;
    }
    if (confirmedExpiresAt && orderData.expires_at) {
      try {
        const expDate = new Date(orderData.expires_at);
        confirmedExpiresAt.textContent = `Hasta el ${expDate.toLocaleDateString()} a las ${expDate.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
      } catch (_) {
        confirmedExpiresAt.textContent = '72 horas para coordinar pago';
      }
    }

    // Configure Operator Protocol notice for Staging (no real QR/charges in staging)
    if (btnWhatsappPayment) {
      btnWhatsappPayment.onclick = (e) => {
        e.preventDefault();
        alert(
          `[Protocolo Operador Humano — Modo Staging]\n\nPedido registrado: #${orderData.order_number}\nCurso: ${prod.title}\nImporte: Bs ${(orderData.total_amount_minor / 100).toFixed(0)} BOB\n\nEn producción, un operador académico recibe la solicitud y envía manualmente el QR bancario oficial. El acceso a Moodle se habilita únicamente cuando el operador verifica efectivamente el abono en el banco.`
        );
      };
    }
  }

  // 11. Real-Time Order Status Check via Opaque Token (Zero PII)
  async function checkOrderStatus() {
    if (!currentOpaqueToken || !statusLookupFeedback) return;

    statusLookupFeedback.hidden = false;
    statusLookupFeedback.className = 'status-lookup-feedback status-checking';
    statusLookupFeedback.textContent = 'Consultando estado seguro con el servidor...';

    try {
      const response = await fetch(`${API_BASE}/api/v1/orders/${encodeURIComponent(currentOpaqueToken)}/status`, {
        method: 'GET',
        headers: { 'Accept': 'application/json' },
      });

      const data = await response.json().catch(() => null);

      if (!response.ok || !data) {
        statusLookupFeedback.className = 'status-lookup-feedback status-error';
        statusLookupFeedback.textContent = 'No se pudo verificar el estado en este momento. Intenta de nuevo más tarde.';
        return;
      }

      statusLookupFeedback.className = 'status-lookup-feedback status-success';
      const statusNames = {
        'pending_payment': 'Pendiente de Pago (Esperando emisión de QR por operador)',
        'paid_verified': 'Pago Verificado en Banco',
        'enrollment_pending': 'Matrícula en Trámite (Moodle)',
        'fulfilled': 'Matriculado / Acceso Habilitado',
        'expired': 'Expirado',
      };
      statusLookupFeedback.innerHTML = `<strong>Estado Verificado:</strong> ${statusNames[data.status] || data.status}`;
      if (confirmedStatusBadge) {
        confirmedStatusBadge.textContent = statusNames[data.status] || data.status;
      }
    } catch (err) {
      statusLookupFeedback.className = 'status-lookup-feedback status-error';
      statusLookupFeedback.textContent = 'Error de conectividad al consultar el estado.';
    }
  }

  // 12. Initialization & Event Binding
  function initCheckout() {
    initElements();

    // Bind Catalog Purchase Buttons
    const catalogButtons = document.querySelectorAll('[data-action="open-checkout"]');
    catalogButtons.forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        const sku = btn.getAttribute('data-sku') || 'mujer-informada-4';
        openCheckout(sku);
      });
    });

    // Close Modal Button & Backdrop
    if (closeBtn) {
      closeBtn.addEventListener('click', closeCheckout);
    }
    if (backdrop) {
      backdrop.addEventListener('click', (e) => {
        if (e.target === backdrop) {
          closeCheckout();
        }
      });
    }

    // Keyboard ESC to Close
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && backdrop && !backdrop.hidden) {
        closeCheckout();
      }
    });

    // SKU Switcher inside Modal
    if (skuSelect) {
      skuSelect.addEventListener('change', (e) => {
        setProduct(e.target.value);
        // Switching product creates a distinct order intent, generate new key
        currentIdempotencyKey = generateUUID();
        clearAlert();
      });
    }

    // Form Submission
    if (form) {
      form.addEventListener('submit', (e) => {
        e.preventDefault();
        submitCheckout();
      });
    }

    // Retry Button
    if (retryBtn) {
      retryBtn.addEventListener('click', () => {
        submitCheckout();
      });
    }

    // Check Order Status Button
    if (btnCheckStatus) {
      btnCheckStatus.addEventListener('click', checkOrderStatus);
    }

    // Close Confirmation Button
    if (btnCloseConfirmation) {
      btnCloseConfirmation.addEventListener('click', closeCheckout);
    }

    // Check for direct SKU hash in URL (e.g. #comprar-endometriosis)
    const hash = window.location.hash;
    if (hash && hash.startsWith('#comprar-')) {
      const requestedSku = hash.replace('#comprar-', '');
      if (PRODUCTS[requestedSku]) {
        openCheckout(requestedSku);
      }
    }
  }

  // Auto-init on DOMContentLoaded
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initCheckout);
  } else {
    initCheckout();
  }

  // Expose API for testing
  window.NovarumCheckout = {
    PRODUCTS,
    openCheckout,
    closeCheckout,
    submitCheckout,
    setProduct,
    validateForm,
    getSanitizedUtm,
    getIdempotencyKey: () => currentIdempotencyKey,
    setIdempotencyKey: (k) => { currentIdempotencyKey = k; },
    getOpaqueToken: () => currentOpaqueToken,
    setOpaqueToken: (t) => { currentOpaqueToken = t; },
  };
})();
