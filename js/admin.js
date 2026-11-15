/**
 * NOVARUM Commercial & Operational Inbox — Admin Client
 * Gate 2-A3-B2 (BL-05): Lightweight Visual CRM & Orders Workspace
 * Reuses nominal authentication, CSRF protection, and transactional endpoints.
 */

(function () {
  'use strict';

  // Available Products & Titles
  const PRODUCTS = {
    'mujer-informada-4': 'Pack Completo: Mujer Informada (4 Cursos)',
    endometriosis: 'Endometriosis y Dolor Pélvico',
    vaginosis: 'Vaginosis Bacteriana y Flujo Vaginal',
    sop: 'Síndrome de Ovario Poliquístico (SOP)',
    'aprende-mujer': 'Aprende Mujer: Autocuidado y Bienestar',
  };

  const FOLLOWUP_STATUS_LABELS = {
    new_inquiry: 'Nueva consulta',
    contacted: 'Contactado',
    checkout_link_sent: 'Link enviado',
    order_created: 'Pedido creado',
    paid_verified: 'Pago verificado',
    enrolled: 'Matriculado',
    closed_no_conversion: 'Cerrado',
    do_not_contact: 'No contactar',
  };

  const ORDER_STATUS_LABELS = {
    pending_payment: 'Pendiente de pago',
    paid_verified: 'Pago verificado',
    fulfilled: 'Matriculado en Moodle',
    cancelled: 'Cancelado',
  };

  // State
  let currentSession = null;
  let inquiriesData = [];
  let ordersData = [];
  let activeInquiryForManage = null;
  let activeOrderForAction = null;

  // Resolve API Base URL
  function getApiBase() {
    if (typeof window.NOVARUM_API_BASE === 'string' && window.NOVARUM_API_BASE.trim()) {
      return window.NOVARUM_API_BASE.trim().replace(/\/+$/, '');
    }
    return window.location.origin;
  }

  // Generate UUID v4 for Idempotency
  function generateUuid() {
    if (window.crypto && crypto.randomUUID) {
      return crypto.randomUUID();
    }
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
      const r = (Math.random() * 16) | 0;
      const v = c === 'x' ? r : (r & 0x3) | 0x8;
      return v.toString(16);
    });
  }

  // Toast Notification
  function showToast(message, type = 'info') {
    const container = document.getElementById('toastContainer');
    if (!container) return;

    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    toast.setAttribute('role', 'alert');

    const icon = type === 'success' ? '✓' : type === 'error' ? '✕' : 'ℹ';
    const iconSpan = document.createElement('span');
    iconSpan.textContent = icon;

    const textSpan = document.createElement('span');
    textSpan.textContent = message;

    toast.appendChild(iconSpan);
    toast.appendChild(textSpan);
    container.appendChild(toast);

    setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transition = 'opacity 0.3s ease';
      setTimeout(() => toast.remove(), 300);
    }, 4500);
  }

  // Standard API Request Helper
  async function apiFetch(path, options = {}) {
    const apiBase = getApiBase();
    const url = `${apiBase}${path}`;
    const headers = {
      Accept: 'application/json',
      ...(options.headers || {}),
    };

    if (currentSession && currentSession.csrfToken && options.method && options.method !== 'GET') {
      headers['x-csrf-token'] = currentSession.csrfToken;
    }

    if (options.body && typeof options.body === 'object' && !(options.body instanceof FormData)) {
      headers['Content-Type'] = 'application/json';
      options.body = JSON.stringify(options.body);
    }

    const res = await fetch(url, {
      ...options,
      headers,
      credentials: 'include',
    });

    let data;
    const text = await res.text();
    try {
      data = JSON.parse(text);
    } catch {
      data = { message: text };
    }

    if (!res.ok) {
      if (res.status === 401 && !path.includes('/session/login')) {
        handleSessionExpired();
      }
      const error = new Error(data.message || `Error del servidor HTTP ${res.status}`);
      error.statusCode = res.status;
      error.code = data.error || 'ERROR';
      error.details = data;
      throw error;
    }

    return data;
  }

  function handleSessionExpired() {
    currentSession = null;
    document.getElementById('userWidget').hidden = true;
    document.getElementById('appWorkspace').hidden = true;
    document.getElementById('loginView').hidden = false;
    showToast('Tu sesión ha expirado o fue revocada. Por favor ingresa nuevamente.', 'error');
  }

  // Format Dates
  function formatDateTime(isoString) {
    if (!isoString) return '—';
    try {
      const d = new Date(isoString);
      return d.toLocaleString('es-BO', {
        day: '2-digit',
        month: '2-digit',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      });
    } catch {
      return String(isoString);
    }
  }

  // =========================================================================
  // AUTHENTICATION LOGIC
  // =========================================================================

  async function handleLogin(e) {
    e.preventDefault();
    const errorBox = document.getElementById('loginError');
    const submitBtn = document.getElementById('loginSubmitBtn');
    errorBox.hidden = true;
    errorBox.textContent = '';
    submitBtn.disabled = true;
    submitBtn.textContent = 'Verificando credenciales...';

    const operatorId = document.getElementById('loginOperatorId').value.trim();
    const password = document.getElementById('loginPassword').value;

    try {
      const data = await apiFetch('/api/v1/admin/session/login', {
        method: 'POST',
        body: { operator_id: operatorId, password },
      });

      currentSession = {
        operator: data.session,
        csrfToken: data.csrf_token,
        expiresAt: data.expires_at,
        academyId: data.session.academy_id || 'dr-sevilla',
      };

      document.getElementById('operatorDisplayName').textContent = data.session.display_name;
      document.getElementById('operatorRoleBadge').textContent = `${data.session.role} · ${currentSession.academyId}`;
      document.getElementById('userWidget').hidden = false;
      document.getElementById('loginView').hidden = true;
      document.getElementById('appWorkspace').hidden = false;

      showToast(`Bienvenido/a, ${data.session.display_name}`, 'success');
      loadInquiries();
      loadOrders();
    } catch (err) {
      errorBox.hidden = false;
      errorBox.textContent = err.message || 'Error al iniciar sesión.';
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = 'Iniciar Sesión Operativa';
    }
  }

  async function handleLogout() {
    if (!currentSession) return;
    try {
      await apiFetch('/api/v1/admin/session/logout', { method: 'POST' });
    } catch (err) {
      console.warn('Logout warning:', err);
    } finally {
      currentSession = null;
      document.getElementById('userWidget').hidden = true;
      document.getElementById('appWorkspace').hidden = true;
      document.getElementById('loginView').hidden = false;
      showToast('Sesión cerrada correctamente.', 'info');
    }
  }

  // =========================================================================
  // TAB SWITCHING
  // =========================================================================

  function switchTab(targetTabId) {
    const tabInquiries = document.getElementById('tabInquiries');
    const tabOrders = document.getElementById('tabOrders');
    const panelInquiries = document.getElementById('panelInquiries');
    const panelOrders = document.getElementById('panelOrders');

    if (targetTabId === 'tabInquiries') {
      tabInquiries.classList.add('active');
      tabInquiries.setAttribute('aria-selected', 'true');
      tabOrders.classList.remove('active');
      tabOrders.setAttribute('aria-selected', 'false');
      panelInquiries.classList.add('active');
      panelInquiries.hidden = false;
      panelOrders.classList.remove('active');
      panelOrders.hidden = true;
      loadInquiries();
    } else {
      tabOrders.classList.add('active');
      tabOrders.setAttribute('aria-selected', 'true');
      tabInquiries.classList.remove('active');
      tabInquiries.setAttribute('aria-selected', 'false');
      panelOrders.classList.add('active');
      panelOrders.hidden = false;
      panelInquiries.classList.remove('active');
      panelInquiries.hidden = true;
      loadOrders();
    }
  }

  // =========================================================================
  // TAB 1: PROSPECTOS & REDES SOCIALES (MINI CRM)
  // =========================================================================

  async function loadInquiries() {
    if (!currentSession) return;
    const tbody = document.getElementById('inquiriesTableBody');
    tbody.innerHTML = '<tr><td colspan="7" class="td-empty">Cargando prospectos...</td></tr>';

    const channel = document.getElementById('filterInquiryChannel').value;
    const sku = document.getElementById('filterInquirySku').value;
    const status = document.getElementById('filterInquiryStatus').value;

    const params = new URLSearchParams();
    if (channel) params.set('channel', channel);
    if (sku) params.set('interested_sku', sku);
    if (status) params.set('followup_status', status);

    try {
      const data = await apiFetch(`/api/v1/admin/inquiries?${params.toString()}`);
      inquiriesData = data.inquiries || [];
      renderInquiriesTable();
      updateInquiriesSummaryPills();
    } catch (err) {
      tbody.innerHTML = `<tr><td colspan="7" class="td-empty" style="color: #991b1b;">Error al cargar prospectos: ${err.message}</td></tr>`;
    }
  }

  function updateInquiriesSummaryPills() {
    let unattended = 0;
    let active = 0;
    let enrolled = 0;
    let closed = 0;

    for (const inq of inquiriesData) {
      if (inq.followup_status === 'new_inquiry') unattended++;
      else if (['contacted', 'checkout_link_sent', 'order_created', 'paid_verified'].includes(inq.followup_status)) active++;
      else if (inq.followup_status === 'enrolled') enrolled++;
      else if (['closed_no_conversion', 'do_not_contact'].includes(inq.followup_status)) closed++;
    }

    document.getElementById('summaryUnattended').querySelector('.pill-text').textContent = `${unattended} sin atender`;
    document.getElementById('summaryActive').querySelector('.pill-text').textContent = `${active} en seguimiento`;
    document.getElementById('summaryEnrolled').querySelector('.pill-text').textContent = `${enrolled} matriculados`;
    document.getElementById('summaryClosed').querySelector('.pill-text').textContent = `${closed} cerrados`;

    const badge = document.getElementById('unattendedInquiriesBadge');
    if (unattended > 0) {
      badge.textContent = String(unattended);
      badge.hidden = false;
    } else {
      badge.hidden = true;
    }
  }

  function renderInquiriesTable() {
    const tbody = document.getElementById('inquiriesTableBody');
    tbody.innerHTML = '';

    const searchTerm = (document.getElementById('searchInquiryText').value || '').toLowerCase().trim();

    const filtered = inquiriesData.filter((item) => {
      if (!searchTerm) return true;
      const name = (item.contact_name || '').toLowerCase();
      const phone = (item.phone || '').toLowerCase();
      const email = (item.email_normalized || '').toLowerCase();
      const handle = (item.contact_handle || '').toLowerCase();
      const sku = (item.interested_sku || '').toLowerCase();
      return name.includes(searchTerm) || phone.includes(searchTerm) || email.includes(searchTerm) || handle.includes(searchTerm) || sku.includes(searchTerm);
    });

    if (filtered.length === 0) {
      tbody.innerHTML = '<tr><td colspan="7" class="td-empty">No se encontraron prospectos con los filtros actuales.</td></tr>';
      return;
    }

    for (const inq of filtered) {
      const tr = document.createElement('tr');

      // 1. Status & Priority Badge
      const tdStatus = document.createElement('td');
      const statusBadge = document.createElement('span');
      let statusClass = 'badge-closed';
      if (inq.followup_status === 'new_inquiry') statusClass = 'badge-new';
      else if (inq.followup_status === 'contacted') statusClass = 'badge-contacted';
      else if (inq.followup_status === 'checkout_link_sent') statusClass = 'badge-link-sent';
      else if (inq.followup_status === 'order_created') statusClass = 'badge-order-created';
      else if (inq.followup_status === 'paid_verified') statusClass = 'badge-paid';
      else if (inq.followup_status === 'enrolled') statusClass = 'badge-enrolled';
      else if (inq.followup_status === 'do_not_contact') statusClass = 'badge-dnc';

      statusBadge.className = `badge ${statusClass}`;
      statusBadge.textContent = FOLLOWUP_STATUS_LABELS[inq.followup_status] || inq.followup_status;
      tdStatus.appendChild(statusBadge);

      // 2. Contact details
      const tdContact = document.createElement('td');
      const channelTag = document.createElement('span');
      channelTag.className = `channel-tag ${inq.channel}`;
      channelTag.textContent = inq.channel;

      const contactName = document.createElement('strong');
      contactName.textContent = inq.contact_name || '(Sin nombre)';

      const contactDetails = document.createElement('div');
      contactDetails.style.fontSize = '0.78rem';
      contactDetails.style.color = '#64748b';
      const detailParts = [];
      if (inq.phone) detailParts.push(inq.phone);
      if (inq.email_normalized) detailParts.push(inq.email_normalized);
      if (inq.contact_handle) detailParts.push(inq.contact_handle);
      contactDetails.textContent = detailParts.join(' · ') || 'Sin teléfono/email';

      tdContact.appendChild(channelTag);
      tdContact.appendChild(contactName);
      tdContact.appendChild(contactDetails);

      // 3. Interested Course
      const tdCourse = document.createElement('td');
      tdCourse.textContent = inq.product_title || PRODUCTS[inq.interested_sku] || inq.interested_sku;

      // 4. Outbound contact allowed
      const tdOutbound = document.createElement('td');
      const outboundBadge = document.createElement('span');
      if (inq.outbound_contact_allowed) {
        outboundBadge.className = 'badge-outbound-ok';
        outboundBadge.textContent = '✓ Permitido';
      } else {
        outboundBadge.className = 'badge-outbound-forbidden';
        outboundBadge.textContent = '🚫 Sin permiso saliente';
      }
      tdOutbound.appendChild(outboundBadge);

      // 5. Assigned & Next Action
      const tdAction = document.createElement('td');
      const actionText = document.createElement('div');
      actionText.textContent = inq.next_action || 'Sin acción programada';
      actionText.style.fontWeight = '500';

      const actionMeta = document.createElement('div');
      actionMeta.style.fontSize = '0.75rem';
      actionMeta.style.color = '#64748b';
      const assigned = inq.assigned_operator_name || inq.assigned_operator_id || 'Sin asignar';
      const nextDate = inq.next_action_at ? formatDateTime(inq.next_action_at) : null;
      actionMeta.textContent = nextDate ? `${assigned} · ${nextDate}` : assigned;

      tdAction.appendChild(actionText);
      tdAction.appendChild(actionMeta);

      // 6. Order Match / Linkage
      const tdOrder = document.createElement('td');
      if (inq.linked_order_id) {
        const linkedSpan = document.createElement('span');
        linkedSpan.className = 'linkage-cell-linked';
        linkedSpan.textContent = `Pedido #${inq.linked_order_number || inq.linked_order_id.slice(0, 8)}`;
        tdOrder.appendChild(linkedSpan);
      } else if (inq.order_match_ambiguous) {
        const ambSpan = document.createElement('span');
        ambSpan.className = 'linkage-cell-ambiguous';
        ambSpan.textContent = '⚠️ Múltiples pedidos';
        ambSpan.title = 'Se detectaron varios pedidos. Confirmar manualmente.';
        tdOrder.appendChild(ambSpan);
      } else if (inq.suggested_order_match) {
        const candSpan = document.createElement('span');
        candSpan.className = 'linkage-cell-candidate';
        candSpan.textContent = `Candidato #${inq.suggested_order_match.order_number}`;
        tdOrder.appendChild(candSpan);
      } else {
        tdOrder.textContent = '—';
        tdOrder.style.color = '#94a3b8';
      }

      // 7. Actions
      const tdActions = document.createElement('td');
      tdActions.style.textAlign = 'right';

      const manageBtn = document.createElement('button');
      manageBtn.type = 'button';
      manageBtn.className = 'btn-row-action';
      manageBtn.textContent = 'Gestionar';
      manageBtn.addEventListener('click', () => openManageInquiryModal(inq));

      const copyLinkBtn = document.createElement('button');
      copyLinkBtn.type = 'button';
      copyLinkBtn.className = 'btn-row-action';
      copyLinkBtn.textContent = 'Link Checkout';
      copyLinkBtn.title = 'Copiar enlace al catálogo con UTMs';
      copyLinkBtn.addEventListener('click', () => copyCheckoutLinkForInquiry(inq));

      tdActions.appendChild(manageBtn);
      tdActions.appendChild(copyLinkBtn);

      tr.appendChild(tdStatus);
      tr.appendChild(tdContact);
      tr.appendChild(tdCourse);
      tr.appendChild(tdOutbound);
      tr.appendChild(tdAction);
      tr.appendChild(tdOrder);
      tr.appendChild(tdActions);

      tbody.appendChild(tr);
    }
  }

  // Copy Checkout Link with UTM
  function copyCheckoutLinkForInquiry(inquiry) {
    const origin = window.location.origin;
    const sku = inquiry.interested_sku || 'mujer-informada-4';
    const channel = inquiry.channel || 'social';
    const leadId = inquiry.id;

    const url = `${origin}/index.html?sku=${encodeURIComponent(sku)}&utm_source=${encodeURIComponent(channel)}&utm_medium=crm_assisted&utm_campaign=social_followup&lead_id=${encodeURIComponent(leadId)}`;

    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(url).then(
        () => showToast('Enlace de checkout copiado al portapapeles con parámetros UTM.', 'success'),
        () => prompt('Copia este enlace de checkout para enviarlo:', url)
      );
    } else {
      prompt('Copia este enlace de checkout para enviarlo:', url);
    }
  }

  // =========================================================================
  // MODAL 1: REGISTRAR NUEVO PROSPECTO (POST)
  // =========================================================================

  function openNewInquiryModal() {
    const modal = document.getElementById('newInquiryModal');
    const form = document.getElementById('newInquiryForm');
    const errBox = document.getElementById('newInquiryError');
    form.reset();
    errBox.hidden = true;
    document.getElementById('newInquiryOutbound').checked = true;
    document.getElementById('basisEvidenceGroup').hidden = true;

    if (modal.showModal) modal.showModal();
    else modal.setAttribute('open', '');
  }

  function closeNewInquiryModal() {
    const modal = document.getElementById('newInquiryModal');
    if (modal.close) modal.close();
    else modal.removeAttribute('open');
  }

  async function handleSaveNewInquiry(e) {
    e.preventDefault();
    const errBox = document.getElementById('newInquiryError');
    const submitBtn = document.getElementById('saveNewInquirySubmitBtn');
    errBox.hidden = true;
    submitBtn.disabled = true;

    const channel = document.getElementById('newInquiryChannel').value;
    const sku = document.getElementById('newInquirySku').value;
    const contactName = document.getElementById('newInquiryName').value.trim();
    const phone = document.getElementById('newInquiryPhone').value.trim();
    const email = document.getElementById('newInquiryEmail').value.trim();
    const handle = document.getElementById('newInquiryHandle').value.trim();
    const basis = document.getElementById('newInquiryBasis').value;
    const evidence = document.getElementById('newInquiryEvidence').value.trim();
    const outboundAllowed = document.getElementById('newInquiryOutbound').checked;
    const category = document.getElementById('newInquiryCategory').value;
    const nextAction = document.getElementById('newInquiryNextAction').value.trim();
    const nextActionAt = document.getElementById('newInquiryNextActionAt').value;
    const notes = document.getElementById('newInquiryNotes').value.trim();

    // Guardrail: Prohibited Clinical Text Check
    const clinicalPatterns = /sangrado|dolor|infecci[oó]n|secreci[oó]n|picaz[oó]n|ardor|vagina|vulva|pelvi|útero|utero|quiste|diagn[oó]stico|s[ií]ntoma/i;
    if (clinicalPatterns.test(notes) || clinicalPatterns.test(nextAction)) {
      errBox.hidden = false;
      errBox.textContent = '⚠️ Restricción de Privacidad: Se detectaron términos clínicos/médicos. No está permitido registrar diagnósticos o síntomas en el CRM comercial.';
      submitBtn.disabled = false;
      return;
    }

    const payload = {
      channel,
      interested_sku: sku,
      contact_name: contactName || undefined,
      phone: phone || undefined,
      email: email || undefined,
      contact_handle: handle || undefined,
      contact_basis: basis,
      contact_basis_evidence: evidence || undefined,
      outbound_contact_allowed: outboundAllowed,
      observation_category: category,
      next_action: nextAction || undefined,
      next_action_at: nextActionAt ? new Date(nextActionAt).toISOString() : undefined,
      notes: notes || undefined,
      assigned_operator_id: currentSession?.operator?.operator_id,
      idempotency_key: generateUuid(),
    };

    try {
      await apiFetch('/api/v1/admin/inquiries', {
        method: 'POST',
        body: payload,
      });

      closeNewInquiryModal();
      showToast('Prospecto registrado exitosamente.', 'success');
      loadInquiries();
    } catch (err) {
      errBox.hidden = false;
      errBox.textContent = err.message || 'Error al registrar prospecto.';
    } finally {
      submitBtn.disabled = false;
    }
  }

  // =========================================================================
  // MODAL 2: GESTIONAR PROSPECTO & VINCULACIÓN (PATCH)
  // =========================================================================

  function openManageInquiryModal(inquiry) {
    activeInquiryForManage = inquiry;
    const modal = document.getElementById('manageInquiryModal');
    const errBox = document.getElementById('manageInquiryError');
    errBox.hidden = true;

    document.getElementById('manageInquirySubtitle').textContent = `ID de consulta: ${inquiry.id}`;
    document.getElementById('summaryContactName').textContent = inquiry.contact_name || '(Sin nombre)';
    document.getElementById('summaryChannel').textContent = inquiry.channel.toUpperCase();
    document.getElementById('summaryPhone').textContent = inquiry.phone || '—';
    document.getElementById('summaryEmail').textContent = inquiry.email_normalized || '—';
    document.getElementById('summaryHandle').textContent = inquiry.contact_handle || '—';
    document.getElementById('summarySku').textContent = PRODUCTS[inquiry.interested_sku] || inquiry.interested_sku;

    // Outbound Permission Warning Banner & Option Disabling
    const alertBanner = document.getElementById('outboundForbiddenAlert');
    const optContacted = document.getElementById('optStatusContacted');
    const optLinkSent = document.getElementById('optStatusLinkSent');

    if (!inquiry.outbound_contact_allowed) {
      alertBanner.hidden = false;
      optContacted.disabled = true;
      optLinkSent.disabled = true;
    } else {
      alertBanner.hidden = true;
      optContacted.disabled = false;
      optLinkSent.disabled = false;
    }

    // Prepopulate Form Fields
    document.getElementById('manageFollowupStatus').value = inquiry.followup_status;
    document.getElementById('manageObservationCategory').value = inquiry.observation_category || 'course_info_requested';
    document.getElementById('manageAssignedOperator').value = inquiry.assigned_operator_id || '';
    document.getElementById('manageNextAction').value = inquiry.next_action || '';
    document.getElementById('manageNextActionAt').value = inquiry.next_action_at ? inquiry.next_action_at.slice(0, 16) : '';
    document.getElementById('manageNotes').value = inquiry.notes || '';

    // Order Linkage Rendering
    renderOrderLinkageSection(inquiry);

    if (modal.showModal) modal.showModal();
    else modal.setAttribute('open', '');
  }

  function closeManageInquiryModal() {
    activeInquiryForManage = null;
    const modal = document.getElementById('manageInquiryModal');
    if (modal.close) modal.close();
    else modal.removeAttribute('open');
  }

  function renderOrderLinkageSection(inquiry) {
    const alreadyLinked = document.getElementById('alreadyLinkedBlock');
    const notLinked = document.getElementById('notLinkedBlock');
    const ambiguousAlert = document.getElementById('ambiguousMatchAlert');
    const candidatesContainer = document.getElementById('candidatesListContainer');
    candidatesContainer.innerHTML = '';

    if (inquiry.linked_order_id) {
      alreadyLinked.hidden = false;
      notLinked.hidden = true;
      document.getElementById('linkedOrderNumberText').textContent = inquiry.linked_order_number || inquiry.linked_order_id.slice(0, 8);
      document.getElementById('linkedOrderStatusText').textContent = inquiry.linked_order_status || 'Vinculado';
      document.getElementById('relinkAccordion').open = false;
      document.getElementById('relinkNewOrderId').value = '';
      document.getElementById('relinkReason').value = '';
      document.getElementById('relinkConfirmCheck').checked = false;
    } else {
      alreadyLinked.hidden = true;
      notLinked.hidden = false;

      const candidates = inquiry.order_match_candidates || [];
      if (inquiry.order_match_ambiguous) {
        ambiguousAlert.hidden = false;
      } else {
        ambiguousAlert.hidden = true;
      }

      if (candidates.length > 0) {
        for (const cand of candidates) {
          const card = document.createElement('div');
          card.className = 'candidate-card';

          const infoDiv = document.createElement('div');
          infoDiv.className = 'candidate-info';
          infoDiv.innerHTML = `<strong>Pedido #${cand.order_number}</strong> — ${cand.product_title} (Bs ${cand.total_amount_cents / 100}) <span class="candidate-match-tag">Coincide por ${cand.matched_by}</span>`;

          const linkBtn = document.createElement('button');
          linkBtn.type = 'button';
          linkBtn.className = 'btn-primary-action btn-sm';
          linkBtn.textContent = 'Confirmar Vinculación';
          linkBtn.addEventListener('click', () => executeOrderLink(inquiry.id, cand.order_id));

          card.appendChild(infoDiv);
          card.appendChild(linkBtn);
          candidatesContainer.appendChild(card);
        }
      } else {
        candidatesContainer.innerHTML = '<span style="font-size: 0.8rem; color: #64748b;">No se encontraron pedidos con el mismo email o teléfono.</span>';
      }
    }
  }

  async function handleSaveManageInquiry(e) {
    e.preventDefault();
    if (!activeInquiryForManage) return;

    const errBox = document.getElementById('manageInquiryError');
    const submitBtn = document.getElementById('saveManageInquiryBtn');
    errBox.hidden = true;
    submitBtn.disabled = true;

    const status = document.getElementById('manageFollowupStatus').value;
    const category = document.getElementById('manageObservationCategory').value;
    const operatorId = document.getElementById('manageAssignedOperator').value.trim();
    const nextAction = document.getElementById('manageNextAction').value.trim();
    const nextActionAt = document.getElementById('manageNextActionAt').value;
    const notes = document.getElementById('manageNotes').value.trim();

    // Guardrail: Prohibited Clinical Text Check
    const clinicalPatterns = /sangrado|dolor|infecci[oó]n|secreci[oó]n|picaz[oó]n|ardor|vagina|vulva|pelvi|útero|utero|quiste|diagn[oó]stico|s[ií]ntoma/i;
    if (clinicalPatterns.test(notes) || clinicalPatterns.test(nextAction)) {
      errBox.hidden = false;
      errBox.textContent = '⚠️ Restricción de Privacidad: Se detectaron términos clínicos/médicos. No está permitido registrar diagnósticos o síntomas en el CRM comercial.';
      submitBtn.disabled = false;
      return;
    }

    const payload = {
      followup_status: status,
      observation_category: category,
      assigned_operator_id: operatorId || null,
      next_action: nextAction || null,
      next_action_at: nextActionAt ? new Date(nextActionAt).toISOString() : null,
      notes: notes || null,
      idempotency_key: generateUuid(),
    };

    try {
      await apiFetch(`/api/v1/admin/inquiries/${activeInquiryForManage.id}`, {
        method: 'PATCH',
        body: payload,
      });

      closeManageInquiryModal();
      showToast('Seguimiento actualizado con éxito.', 'success');
      loadInquiries();
    } catch (err) {
      errBox.hidden = false;
      errBox.textContent = err.message || 'Error al actualizar prospecto.';
    } finally {
      submitBtn.disabled = false;
    }
  }

  async function executeOrderLink(inquiryId, orderId) {
    try {
      await apiFetch(`/api/v1/admin/inquiries/${inquiryId}`, {
        method: 'PATCH',
        body: {
          linked_order_id: orderId,
          idempotency_key: generateUuid(),
        },
      });

      showToast(`Pedido vinculado correctamente al prospecto.`, 'success');
      closeManageInquiryModal();
      loadInquiries();
    } catch (err) {
      const errBox = document.getElementById('manageInquiryError');
      errBox.hidden = false;
      errBox.textContent = err.message || 'Error al vincular pedido.';
    }
  }

  async function handleRelinkOrder() {
    if (!activeInquiryForManage) return;
    const newOrderId = document.getElementById('relinkNewOrderId').value.trim();
    const reason = document.getElementById('relinkReason').value.trim();
    const confirmed = document.getElementById('relinkConfirmCheck').checked;
    const errBox = document.getElementById('manageInquiryError');
    errBox.hidden = true;

    if (!newOrderId) {
      errBox.hidden = false;
      errBox.textContent = 'Ingresa el nuevo ID de pedido a vincular.';
      return;
    }

    if (!reason) {
      errBox.hidden = false;
      errBox.textContent = 'Se requiere un motivo documentado para reasignar el vínculo de pedido.';
      return;
    }

    if (!confirmed) {
      errBox.hidden = false;
      errBox.textContent = 'Debes marcar la casilla de confirmación explícita para la reasignación.';
      return;
    }

    try {
      await apiFetch(`/api/v1/admin/inquiries/${activeInquiryForManage.id}`, {
        method: 'PATCH',
        body: {
          linked_order_id: newOrderId,
          confirm_order_relink: true,
          expected_linked_order_id: activeInquiryForManage.linked_order_id,
          relink_reason: reason,
          idempotency_key: generateUuid(),
        },
      });

      showToast('Reasignación excepcional de pedido ejecutada y auditada.', 'success');
      closeManageInquiryModal();
      loadInquiries();
    } catch (err) {
      errBox.hidden = false;
      errBox.textContent = err.message || 'Error en la reasignación.';
    }
  }

  // =========================================================================
  // TAB 2: PEDIDOS Y MATRÍCULAS HUMANAS
  // =========================================================================

  async function loadOrders() {
    if (!currentSession) return;
    const tbody = document.getElementById('ordersTableBody');
    tbody.innerHTML = '<tr><td colspan="7" class="td-empty">Cargando pedidos...</td></tr>';

    const status = document.getElementById('filterOrderStatus').value;
    const params = new URLSearchParams();
    if (status) params.set('status', status);

    try {
      const data = await apiFetch(`/api/v1/admin/orders?${params.toString()}`);
      ordersData = (data.orders || []).map((o) => ({
        ...o,
        buyer_name: o.lead_name || o.buyer_name || 'Compradora',
        buyer_email: o.lead_email || o.buyer_email || '',
        buyer_phone: o.lead_phone || o.buyer_phone || '',
        total_amount_cents: o.total_amount_minor ?? o.total_amount_cents ?? 0,
      }));
      renderOrdersTable();

      const pendingCount = ordersData.filter((o) => o.status === 'pending_payment').length;
      const badge = document.getElementById('pendingOrdersBadge');
      if (pendingCount > 0) {
        badge.textContent = String(pendingCount);
        badge.hidden = false;
      } else {
        badge.hidden = true;
      }
    } catch (err) {
      tbody.innerHTML = `<tr><td colspan="7" class="td-empty" style="color: #991b1b;">Error al cargar pedidos: ${err.message}</td></tr>`;
    }
  }

  function renderOrdersTable() {
    const tbody = document.getElementById('ordersTableBody');
    tbody.innerHTML = '';

    const searchTerm = (document.getElementById('searchOrderText').value || '').toLowerCase().trim();

    const filtered = ordersData.filter((item) => {
      if (!searchTerm) return true;
      const num = (item.order_number || '').toLowerCase();
      const name = (item.buyer_name || '').toLowerCase();
      const email = (item.buyer_email || '').toLowerCase();
      const phone = (item.buyer_phone || '').toLowerCase();
      return num.includes(searchTerm) || name.includes(searchTerm) || email.includes(searchTerm) || phone.includes(searchTerm);
    });

    if (filtered.length === 0) {
      tbody.innerHTML = '<tr><td colspan="7" class="td-empty">No se encontraron pedidos con los filtros actuales.</td></tr>';
      return;
    }

    for (const order of filtered) {
      const tr = document.createElement('tr');

      // 1. Order Number & Date
      const tdOrderNum = document.createElement('td');
      const numStrong = document.createElement('strong');
      numStrong.textContent = `#${order.order_number}`;
      const dateDiv = document.createElement('div');
      dateDiv.style.fontSize = '0.75rem';
      dateDiv.style.color = '#64748b';
      dateDiv.textContent = formatDateTime(order.created_at);
      tdOrderNum.appendChild(numStrong);
      tdOrderNum.appendChild(dateDiv);

      // 2. Buyer Info
      const tdBuyer = document.createElement('td');
      const buyerName = document.createElement('strong');
      buyerName.textContent = order.buyer_name || 'Compradora';
      const buyerContact = document.createElement('div');
      buyerContact.style.fontSize = '0.78rem';
      buyerContact.style.color = '#64748b';
      buyerContact.textContent = `${order.buyer_email} · ${order.buyer_phone || 'Sin tel.'}`;
      tdBuyer.appendChild(buyerName);
      tdBuyer.appendChild(buyerContact);

      // 3. Product & Amount
      const tdProduct = document.createElement('td');
      const prodTitle = document.createElement('div');
      prodTitle.textContent = order.product_title || PRODUCTS[order.sku] || order.sku;
      const prodAmount = document.createElement('strong');
      prodAmount.style.color = '#0f172a';
      prodAmount.textContent = `${order.currency} ${(order.total_amount_cents / 100).toFixed(2)}`;
      tdProduct.appendChild(prodTitle);
      tdProduct.appendChild(prodAmount);

      // 4. Payment Status Badge
      const tdPayment = document.createElement('td');
      const payBadge = document.createElement('span');
      if (order.status === 'paid_verified' || order.status === 'fulfilled') {
        payBadge.className = 'badge badge-paid';
        payBadge.textContent = '✓ Pago Verificado';
      } else if (order.status === 'cancelled') {
        payBadge.className = 'badge badge-dnc';
        payBadge.textContent = 'Cancelado';
      } else {
        payBadge.className = 'badge badge-contacted';
        payBadge.textContent = 'Pendiente de Pago';
      }
      tdPayment.appendChild(payBadge);

      // 5. Moodle Enrollment Status
      const tdMoodle = document.createElement('td');
      const moodleBadge = document.createElement('span');
      if (order.status === 'fulfilled') {
        moodleBadge.className = 'badge badge-enrolled';
        moodleBadge.textContent = '✓ Matriculado en Moodle';
      } else if (order.status === 'enrollment_pending') {
        moodleBadge.className = 'badge badge-link-sent';
        moodleBadge.textContent = 'Matrícula en Proceso';
      } else if (order.status === 'paid_verified') {
        moodleBadge.className = 'badge badge-interested';
        moodleBadge.textContent = 'Listo para Matricular';
      } else {
        moodleBadge.className = 'badge badge-closed';
        moodleBadge.textContent = 'Pendiente de Pago';
      }
      tdMoodle.appendChild(moodleBadge);

      // 6. Reconciliation Reference
      const tdRef = document.createElement('td');
      if (order.bank_reconciliation_ref) {
        tdRef.innerHTML = `<strong>${order.bank_name || 'Banco'}</strong><div style="font-size: 0.75rem; color: #64748b;">${order.bank_reconciliation_ref}</div>`;
      } else {
        tdRef.textContent = '—';
        tdRef.style.color = '#94a3b8';
      }

      // 7. Contextual Actions
      const tdActions = document.createElement('td');
      tdActions.style.textAlign = 'right';

      if (order.status === 'pending_payment') {
        const coordBtn = document.createElement('button');
        coordBtn.type = 'button';
        coordBtn.className = 'btn-row-action';
        coordBtn.textContent = 'Enviar QR';
        coordBtn.addEventListener('click', () => openCoordinationModal(order));

        const verifyBtn = document.createElement('button');
        verifyBtn.type = 'button';
        verifyBtn.className = 'btn-row-action';
        verifyBtn.style.color = '#047857';
        verifyBtn.style.borderColor = '#A7F3D0';
        verifyBtn.textContent = 'Verificar Pago';
        verifyBtn.addEventListener('click', () => openVerifyPaymentModal(order));

        tdActions.appendChild(coordBtn);
        tdActions.appendChild(verifyBtn);
      } else if (order.status === 'paid_verified') {
        const enrollBtn = document.createElement('button');
        enrollBtn.type = 'button';
        enrollBtn.className = 'btn-row-action';
        enrollBtn.style.color = '#831843';
        enrollBtn.style.borderColor = '#FBCFE8';
        enrollBtn.textContent = 'Iniciar Matrícula';
        enrollBtn.addEventListener('click', () => openEnrollmentModal(order));
        tdActions.appendChild(enrollBtn);
      } else if (order.status === 'enrollment_pending') {
        const enrollBtn = document.createElement('button');
        enrollBtn.type = 'button';
        enrollBtn.className = 'btn-row-action';
        enrollBtn.style.color = '#831843';
        enrollBtn.style.borderColor = '#FBCFE8';
        enrollBtn.textContent = 'Confirmar Moodle';
        enrollBtn.addEventListener('click', () => openEnrollmentModal(order));
        tdActions.appendChild(enrollBtn);
      } else if (order.status === 'fulfilled') {
        const viewSpan = document.createElement('span');
        viewSpan.style.fontSize = '0.78rem';
        viewSpan.style.color = '#059669';
        viewSpan.textContent = '✓ Matrícula Completa';
        tdActions.appendChild(viewSpan);
      }

      tr.appendChild(tdOrderNum);
      tr.appendChild(tdBuyer);
      tr.appendChild(tdProduct);
      tr.appendChild(tdPayment);
      tr.appendChild(tdMoodle);
      tr.appendChild(tdRef);
      tr.appendChild(tdActions);

      tbody.appendChild(tr);
    }
  }

  // =========================================================================
  // MODAL 3: COORDINACIÓN MANUAL DE QR
  // =========================================================================

  function openCoordinationModal(order) {
    activeOrderForAction = order;
    const modal = document.getElementById('coordinationModal');
    const form = document.getElementById('coordinationForm');
    const errBox = document.getElementById('coordinationError');
    form.reset();
    errBox.hidden = true;
    document.getElementById('coordinationOrderSubtitle').textContent = `Pedido #${order.order_number} · ${order.buyer_name}`;

    if (modal.showModal) modal.showModal();
    else modal.setAttribute('open', '');
  }

  function closeCoordinationModal() {
    activeOrderForAction = null;
    const modal = document.getElementById('coordinationModal');
    if (modal.close) modal.close();
    else modal.removeAttribute('open');
  }

  async function handleSaveCoordination(e) {
    e.preventDefault();
    if (!activeOrderForAction) return;

    const errBox = document.getElementById('coordinationError');
    const submitBtn = document.getElementById('saveCoordinationBtn');
    errBox.hidden = true;
    submitBtn.disabled = true;

    const eventType = document.getElementById('coordinationEventType').value;
    const channel = document.getElementById('coordinationChannel').value;
    const notes = document.getElementById('coordinationNotes').value.trim();

    try {
      await apiFetch(`/api/v1/admin/orders/${activeOrderForAction.id}/coordination`, {
        method: 'POST',
        body: {
          event_type: eventType,
          channel,
          notes: notes || undefined,
          idempotency_key: generateUuid(),
        },
      });

      closeCoordinationModal();
      showToast('Evento de coordinación registrado.', 'success');
      loadOrders();
    } catch (err) {
      errBox.hidden = false;
      errBox.textContent = err.message || 'Error al registrar coordinación.';
    } finally {
      submitBtn.disabled = false;
    }
  }

  // =========================================================================
  // MODAL 4: VERIFICACIÓN BANCARIA DEL PAGO
  // =========================================================================

  function openVerifyPaymentModal(order) {
    activeOrderForAction = order;
    const modal = document.getElementById('verifyPaymentModal');
    const form = document.getElementById('verifyPaymentForm');
    const errBox = document.getElementById('verifyPaymentError');
    form.reset();
    errBox.hidden = true;

    document.getElementById('verifyPaymentOrderSubtitle').textContent = `Pedido #${order.order_number} · ${order.buyer_name}`;
    document.getElementById('verifyAmountCents').value = order.total_amount_cents;
    document.getElementById('verifyAmountBsHint').textContent = `Bs ${(order.total_amount_cents / 100).toFixed(2)}`;

    if (modal.showModal) modal.showModal();
    else modal.setAttribute('open', '');
  }

  function closeVerifyPaymentModal() {
    activeOrderForAction = null;
    const modal = document.getElementById('verifyPaymentModal');
    if (modal.close) modal.close();
    else modal.removeAttribute('open');
  }

  async function handleSaveVerifyPayment(e) {
    e.preventDefault();
    if (!activeOrderForAction) return;

    const errBox = document.getElementById('verifyPaymentError');
    const submitBtn = document.getElementById('saveVerifyPaymentBtn');
    errBox.hidden = true;
    submitBtn.disabled = true;

    const bankRef = document.getElementById('verifyBankRef').value.trim();
    const bankName = document.getElementById('verifyBankName').value;
    const amountCents = parseInt(document.getElementById('verifyAmountCents').value, 10);
    const notes = document.getElementById('verifyNotes').value.trim();

    if (!bankRef) {
      errBox.hidden = false;
      errBox.textContent = 'La referencia bancaria es obligatoria para certificar el abono.';
      submitBtn.disabled = false;
      return;
    }

    try {
      await apiFetch(`/api/v1/admin/orders/${activeOrderForAction.id}/verify-payment`, {
        method: 'POST',
        body: {
          reconciliation_mode: 'standard_reference',
          bank_reference: bankRef,
          recipient_account_id: 'BNB-DR-SEVILLA-BOB-01',
          recipient_account_verified: true,
          effective_transaction_verified: true,
          bank_credit_at: new Date().toISOString(),
          verified_amount_minor: activeOrderForAction.total_amount_minor || activeOrderForAction.total_amount_cents,
          verified_currency: activeOrderForAction.currency || 'BOB',
          reconciliation_evidence: notes && notes.length >= 10 ? notes : `Abono QR verificado en extracto ${bankName} con referencia ${bankRef}`,
          reason: notes && notes.length >= 10 ? notes : `Verificación de pago bancario para pedido #${activeOrderForAction.order_number}`,
          idempotency_key: generateUuid(),
        },
      });

      closeVerifyPaymentModal();
      showToast('Pago verificado y registrado en extracto.', 'success');
      loadOrders();
    } catch (err) {
      errBox.hidden = false;
      errBox.textContent = err.message || 'Error al verificar pago.';
    } finally {
      submitBtn.disabled = false;
    }
  }

  // =========================================================================
  // MODAL 5: REGISTRO DE MATRÍCULA MANUAL MOODLE
  // =========================================================================

  function openEnrollmentModal(order) {
    activeOrderForAction = order;
    const modal = document.getElementById('enrollmentModal');
    const form = document.getElementById('enrollmentForm');
    const errBox = document.getElementById('enrollmentError');
    form.reset();
    errBox.hidden = true;

    document.getElementById('enrollmentOrderSubtitle').textContent = `Pedido #${order.order_number} · ${order.buyer_name}`;
    if (order.status === 'enrollment_pending') {
      document.getElementById('enrollmentActionType').value = 'confirm';
    } else {
      document.getElementById('enrollmentActionType').value = 'start';
    }

    if (modal.showModal) modal.showModal();
    else modal.setAttribute('open', '');
  }

  function closeEnrollmentModal() {
    activeOrderForAction = null;
    const modal = document.getElementById('enrollmentModal');
    if (modal.close) modal.close();
    else modal.removeAttribute('open');
  }

  async function handleSaveEnrollment(e) {
    e.preventDefault();
    if (!activeOrderForAction) return;

    const errBox = document.getElementById('enrollmentError');
    const submitBtn = document.getElementById('saveEnrollmentBtn');
    errBox.hidden = true;
    submitBtn.disabled = true;

    const actionType = document.getElementById('enrollmentActionType').value;
    const notes = document.getElementById('enrollmentNotes').value.trim();
    const endpoint = actionType === 'start' ? 'start-enrollment' : 'confirm-enrollment';

    const enrollmentPayload = actionType === 'start'
      ? {
          reason: notes && notes.length >= 10 ? notes : `Iniciando matrícula manual en Moodle para pedido #${activeOrderForAction.order_number}`,
          idempotency_key: generateUuid(),
        }
      : {
          moodle_user_identifier: activeOrderForAction.lead_email || activeOrderForAction.buyer_email,
          moodle_courses_enrolled: activeOrderForAction.sku === 'mujer-informada-4' ? ['endometriosis', 'vaginosis', 'sop', 'aprende-mujer'] : [activeOrderForAction.sku],
          access_confirmed: true,
          reason: notes && notes.length >= 10 ? notes : `Habilitación completa de matrícula en Moodle confirmada para pedido #${activeOrderForAction.order_number}`,
          idempotency_key: generateUuid(),
        };

    try {
      await apiFetch(`/api/v1/admin/orders/${activeOrderForAction.id}/${endpoint}`, {
        method: 'POST',
        body: enrollmentPayload,
      });

      closeEnrollmentModal();
      showToast(actionType === 'start' ? 'Inicio de matrícula registrado.' : 'Habilitación en Moodle confirmada con éxito.', 'success');
      loadOrders();
    } catch (err) {
      errBox.hidden = false;
      errBox.textContent = err.message || 'Error al registrar matrícula.';
    } finally {
      submitBtn.disabled = false;
    }
  }

  // =========================================================================
  // INITIALIZATION AND EVENT LISTENERS
  // =========================================================================

  function initAdmin() {
    // Auth
    document.getElementById('loginForm')?.addEventListener('submit', handleLogin);
    document.getElementById('logoutBtn')?.addEventListener('click', handleLogout);

    // Tab buttons
    document.getElementById('tabInquiries')?.addEventListener('click', () => switchTab('tabInquiries'));
    document.getElementById('tabOrders')?.addEventListener('click', () => switchTab('tabOrders'));

    // Inquiries Actions & Filters
    document.getElementById('refreshInquiriesBtn')?.addEventListener('click', loadInquiries);
    document.getElementById('filterInquiryChannel')?.addEventListener('change', loadInquiries);
    document.getElementById('filterInquirySku')?.addEventListener('change', loadInquiries);
    document.getElementById('filterInquiryStatus')?.addEventListener('change', loadInquiries);
    document.getElementById('searchInquiryText')?.addEventListener('input', renderInquiriesTable);

    // Modal 1: New Inquiry
    document.getElementById('openNewInquiryModalBtn')?.addEventListener('click', openNewInquiryModal);
    document.getElementById('closeNewInquiryModalBtn')?.addEventListener('click', closeNewInquiryModal);
    document.getElementById('cancelNewInquiryBtn')?.addEventListener('click', closeNewInquiryModal);
    document.getElementById('newInquiryForm')?.addEventListener('submit', handleSaveNewInquiry);
    document.getElementById('newInquiryBasis')?.addEventListener('change', (e) => {
      const isExplicit = e.target.value === 'explicit_opt_in';
      document.getElementById('basisEvidenceGroup').hidden = !isExplicit;
    });

    // Modal 2: Manage Inquiry
    document.getElementById('closeManageInquiryModalBtn')?.addEventListener('click', closeManageInquiryModal);
    document.getElementById('cancelManageInquiryBtn')?.addEventListener('click', closeManageInquiryModal);
    document.getElementById('manageInquiryForm')?.addEventListener('submit', handleSaveManageInquiry);
    document.getElementById('executeRelinkBtn')?.addEventListener('click', handleRelinkOrder);
    document.getElementById('manualLinkBtn')?.addEventListener('click', () => {
      const manualId = document.getElementById('manualLinkOrderId').value.trim();
      if (manualId && activeInquiryForManage) executeOrderLink(activeInquiryForManage.id, manualId);
    });
    document.getElementById('copyCheckoutLinkFromModalBtn')?.addEventListener('click', () => {
      if (activeInquiryForManage) copyCheckoutLinkForInquiry(activeInquiryForManage);
    });

    // Orders Actions & Filters
    document.getElementById('refreshOrdersBtn')?.addEventListener('click', loadOrders);
    document.getElementById('filterOrderStatus')?.addEventListener('change', loadOrders);
    document.getElementById('searchOrderText')?.addEventListener('input', renderOrdersTable);

    // Modal 3: Coordination
    document.getElementById('closeCoordinationModalBtn')?.addEventListener('click', closeCoordinationModal);
    document.getElementById('cancelCoordinationBtn')?.addEventListener('click', closeCoordinationModal);
    document.getElementById('coordinationForm')?.addEventListener('submit', handleSaveCoordination);

    // Modal 4: Verify Payment
    document.getElementById('closeVerifyPaymentModalBtn')?.addEventListener('click', closeVerifyPaymentModal);
    document.getElementById('cancelVerifyPaymentBtn')?.addEventListener('click', closeVerifyPaymentModal);
    document.getElementById('verifyPaymentForm')?.addEventListener('submit', handleSaveVerifyPayment);

    // Modal 5: Enrollment
    document.getElementById('closeEnrollmentModalBtn')?.addEventListener('click', closeEnrollmentModal);
    document.getElementById('cancelEnrollmentBtn')?.addEventListener('click', closeEnrollmentModal);
    document.getElementById('enrollmentForm')?.addEventListener('submit', handleSaveEnrollment);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initAdmin);
  } else {
    initAdmin();
  }

  // Expose API for headless testing
  window.NovarumAdmin = {
    get currentSession() { return currentSession; },
    get inquiriesData() { return inquiriesData; },
    get ordersData() { return ordersData; },
    apiFetch,
    loadInquiries,
    loadOrders,
  };
})();
