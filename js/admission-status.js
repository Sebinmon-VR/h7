/* H7 EdTech — the family's private application page (admission-status.html).
   Opens one application from the link in the admissions emails (?t=...), shows where it
   has got to, lets the family upload the documents the office asked for and send proof of
   the admission fee. Everything the page needs to know about the API is the data-api
   attribute on #statusApp. Every string from the server goes in as text, never as HTML. */
(function () {
    'use strict';

    var root = document.getElementById('statusApp');
    if (!root) return;

    var query = new URLSearchParams(window.location.search);
    var apiOrigin = (query.get('api') || root.getAttribute('data-api') || '').replace(/\/+$/, '');
    var API = apiOrigin + '/api/v1';
    var TOKEN = String(query.get('t') || '').trim();
    var TOKEN_SHAPE = /^[A-Za-z0-9_-]{24,100}$/;
    var PORTAL = API + '/admissions/requests/portal/' + encodeURIComponent(TOKEN);

    // What Razorpay adds to the return address after a payment-link payment.
    var RAZORPAY_PARAMS = [
        'razorpay_payment_id', 'razorpay_payment_link_id', 'razorpay_payment_link_reference_id',
        'razorpay_payment_link_status', 'razorpay_signature'
    ];

    var ACCEPT = '.pdf,.jpg,.jpeg,.png,.webp,.heic,.heif';
    var EXTENSIONS = ['pdf', 'jpg', 'jpeg', 'png', 'webp', 'heic', 'heif'];
    // The server's gateway read-back is throttled to one every ten seconds per application.
    var CHECK_GAP_MS = 10000;

    var DOC_STATUS = {
        PENDING: { label: 'Not uploaded', tone: 'neutral', icon: 'fa-circle' },
        UPLOADED: { label: 'Uploaded', tone: 'info', icon: 'fa-cloud-arrow-up' },
        SUBMITTED: { label: 'Being verified', tone: 'wait', icon: 'fa-hourglass-half' },
        ACCEPTED: { label: 'Verified', tone: 'ok', icon: 'fa-check' },
        REJECTED: { label: 'Upload again', tone: 'bad', icon: 'fa-rotate-right' }
    };
    var PAY_STATUS = {
        REQUESTED: { label: 'Awaiting payment', tone: 'wait', icon: 'fa-clock' },
        SUBMITTED: { label: 'Being verified', tone: 'info', icon: 'fa-hourglass-half' },
        VERIFIED: { label: 'Paid', tone: 'ok', icon: 'fa-check' },
        REJECTED: { label: 'Not confirmed', tone: 'bad', icon: 'fa-triangle-exclamation' }
    };
    var SUBMISSION_STATUS = {
        PENDING: { label: 'Being checked', tone: 'info', icon: 'fa-hourglass-half' },
        ACCEPTED: { label: 'Confirmed', tone: 'ok', icon: 'fa-check' },
        REJECTED: { label: 'Not confirmed', tone: 'bad', icon: 'fa-xmark' }
    };
    var STAGE = {
        NEW: ['fa-hourglass-half', 'wait'],
        UNDER_REVIEW: ['fa-magnifying-glass', 'wait'],
        WAITLISTED: ['fa-list-ol', 'wait'],
        DOCUMENTS_REQUESTED: ['fa-file-arrow-up', 'action'],
        DOCUMENTS_SUBMITTED: ['fa-magnifying-glass', 'wait'],
        DOCUMENTS_VERIFIED: ['fa-circle-check', 'ok'],
        PAYMENT_REQUESTED: ['fa-credit-card', 'action'],
        PAYMENT_SUBMITTED: ['fa-magnifying-glass', 'wait'],
        PAYMENT_VERIFIED: ['fa-circle-check', 'ok'],
        ADMITTED: ['fa-graduation-cap', 'ok'],
        REJECTED: ['fa-circle-info', 'closed']
    };
    var STEP_WORDS = { done: 'completed', current: 'current step', upcoming: 'not started yet', stopped: 'closed' };
    var METHODS = [
        ['UPI', 'UPI'], ['BANK_TRANSFER', 'Bank transfer'], ['CARD', 'Card'],
        ['CASH', 'Cash'], ['CHEQUE', 'Cheque'], ['OTHER', 'Other']
    ];

    var el = {
        loading: document.getElementById('statusLoading'),
        invalid: document.getElementById('statusInvalid'),
        invalidMessage: document.getElementById('invalidMessage'),
        offline: document.getElementById('statusOffline'),
        offlineMessage: document.getElementById('offlineMessage'),
        retry: document.getElementById('retryLoad'),
        view: document.getElementById('statusView')
    };

    var state = {
        data: null,
        busy: false,
        payFormOpen: null,   // null: let the payment's status decide
        lastCheck: 0
    };

    /* --- small helpers ------------------------------------------------------ */
    function show(node) { if (node) node.classList.remove('is-hidden'); }
    function hide(node) { if (node) node.classList.add('is-hidden'); }

    // Builds an element. `text` is set with textContent; children that are strings become
    // text nodes. Nothing here ever parses a string as HTML.
    function h(tag, props, children) {
        var node = document.createElement(tag);
        props = props || {};
        Object.keys(props).forEach(function (key) {
            var value = props[key];
            if (value === null || value === undefined || value === false) return;
            if (key === 'class') node.className = value;
            else if (key === 'text') node.textContent = String(value);
            else if (key.slice(0, 2) === 'on') node.addEventListener(key.slice(2), value);
            else node.setAttribute(key, value === true ? '' : String(value));
        });
        return append(node, children);
    }

    function append(node, children) {
        if (children === null || children === undefined) return node;
        if (!Array.isArray(children)) children = [children];
        children.forEach(function (child) {
            if (child === null || child === undefined || child === false) return;
            node.appendChild(typeof child === 'string' || typeof child === 'number'
                ? document.createTextNode(String(child)) : child);
        });
        return node;
    }

    function empty(node) { while (node && node.firstChild) node.removeChild(node.firstChild); }
    function icon(name) { return h('i', { class: 'fa-solid ' + name, 'aria-hidden': 'true' }); }
    function plural(n, word) { return n + ' ' + word + (n === 1 ? '' : 's'); }
    function safeId(value) { return String(value).replace(/[^A-Za-z0-9_-]/g, '_'); }

    function safeUrl(value) {
        var url = String(value || '').trim();
        return /^https?:\/\//i.test(url) ? url : null;
    }

    function extension(name) {
        var match = /\.([A-Za-z0-9]+)$/.exec(String(name || ''));
        return match ? match[1].toLowerCase() : '';
    }

    function todayIso() {
        var now = new Date();
        return now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0') + '-' +
            String(now.getDate()).padStart(2, '0');
    }

    /* --- formatting ---------------------------------------------------------- */
    // A calendar date ("2026-10-12") is shown as that day wherever the family is.
    function formatDate(value) {
        var match = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(value || ''));
        if (!match) return '';
        var day = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
        try {
            return day.toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' });
        } catch (e) { return match[0]; }
    }

    // Moments come back from the server in UTC, sometimes without the zone marker.
    function parseMoment(value) {
        if (!value) return null;
        var text = String(value).replace(/(\.\d{3})\d+/, '$1');
        if (!/(Z|[+-]\d{2}:?\d{2})$/i.test(text)) text += 'Z';
        var moment = new Date(text);
        return isNaN(moment.getTime()) ? null : moment;
    }

    function formatMoment(value, withTime) {
        var moment = parseMoment(value);
        if (!moment) return '';
        var options = { day: 'numeric', month: 'long', year: 'numeric' };
        if (withTime) { options.hour = 'numeric'; options.minute = '2-digit'; }
        try { return moment.toLocaleString('en-IN', options); } catch (e) { return moment.toDateString(); }
    }

    function money(amount, currency) {
        var code = String(currency || 'INR').toUpperCase();
        var number = Number(amount);
        if (!isFinite(number)) return '';
        try {
            return new Intl.NumberFormat('en-IN', { style: 'currency', currency: code }).format(number);
        } catch (e) {
            return code + ' ' + number.toFixed(2);
        }
    }

    function formatSize(bytes) {
        var n = Number(bytes);
        if (!isFinite(n) || n <= 0) return '';
        if (n < 1024) return n + ' B';
        if (n < 1024 * 1024) return Math.round(n / 1024) + ' KB';
        return (n / (1024 * 1024)).toFixed(1).replace(/\.0$/, '') + ' MB';
    }

    /* --- messages near each action ----------------------------------------- */
    var ALERT_ICONS = {
        info: 'fa-circle-info', warn: 'fa-circle-info',
        error: 'fa-triangle-exclamation', success: 'fa-circle-check'
    };

    function setAlert(slot, kind, message, spin) {
        if (!slot) return null;
        empty(slot);
        if (!kind) return null;
        var box = h('div', {
            class: 'form-alert form-alert--' + kind,
            role: kind === 'error' ? 'alert' : null,
            tabindex: '-1'
        }, [icon(spin ? 'fa-circle-notch fa-spin' : ALERT_ICONS[kind]), h('span', { text: message })]);
        slot.appendChild(box);
        return box;
    }

    function focusNode(node) {
        if (!node) return;
        try { node.focus({ preventScroll: true }); } catch (e) { node.focus(); }
        var box = node.getBoundingClientRect();
        if (box.top < 80 || box.bottom > window.innerHeight) {
            node.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
    }

    function focusAlert(slot) { if (slot && slot.firstChild) focusNode(slot.firstChild); }

    // Swaps a button's content for a spinner; returns a function that puts it back.
    function spinButton(button, label) {
        if (!button) return function () {};
        var saved = Array.prototype.slice.call(button.childNodes);
        empty(button);
        append(button, [icon('fa-circle-notch fa-spin'), ' ' + label]);
        return function () { empty(button); append(button, saved); };
    }

    // Every action button carries data-lock; data-off marks one that is off on its own merits.
    function applyBusy() {
        Array.prototype.forEach.call(el.view.querySelectorAll('[data-lock]'), function (node) {
            node.disabled = state.busy || node.hasAttribute('data-off');
        });
        el.view.setAttribute('aria-busy', state.busy ? 'true' : 'false');
    }

    function setBusy(busy) { state.busy = busy; applyBusy(); }

    /* --- talking to the admissions office --------------------------------- */
    function describeFailure(status, data) {
        var detail = data && data.detail;
        if (typeof detail === 'string' && detail) return detail;
        if (status === 422 && Array.isArray(detail)) {
            var messages = detail.map(function (item) {
                return String((item && item.msg) || '').replace(/^Value error,\s*/i, '');
            }).filter(Boolean);
            if (messages.length) return 'Please check the details: ' + messages.join(' ');
        }
        if (status === 413) return 'That file is too large. Please upload a smaller scan or photo.';
        if (status === 429) return 'Too many attempts from this connection. Please try again later, or contact the school office.';
        if (status === 404) return 'This link is not valid. Please use the most recent email from the admissions office, or contact the school office for help.';
        return 'Something went wrong on our side. Please try again in a moment, or contact the school office.';
    }

    function call(method, path, body) {
        return fetch(PORTAL + path, {
            method: method,
            headers: { Accept: 'application/json' },
            body: body || undefined
        }).then(function (res) {
            return res.json().catch(function () { return null; }).then(function (data) {
                if (res.ok && data) return data;
                var error = new Error(describeFailure(res.status, data));
                error.status = res.status;
                throw error;
            });
        }, function () {
            var error = new Error('We could not reach the admissions office just now. Check your internet connection and try again.');
            error.status = 0;
            error.offline = true;
            throw error;
        });
    }

    /* --- the page states ---------------------------------------------------- */
    function showOnly(node) {
        [el.loading, el.invalid, el.offline, el.view].forEach(function (each) {
            if (each === node) show(each); else hide(each);
        });
    }

    function showInvalid(message) {
        if (message) el.invalidMessage.textContent = message;
        showOnly(el.invalid);
        focusNode(el.invalid);
    }

    function showOffline(message) {
        el.offlineMessage.textContent = message ||
            'Please check your internet connection and try again. If this keeps happening, contact the school office.';
        showOnly(el.offline);
        focusNode(el.offline);
    }

    function hasRazorpayReturn() {
        return RAZORPAY_PARAMS.some(function (name) { return query.has(name); });
    }

    // Keeps ?t= (and ?api=) so the address stays the family's bookmark; drops the gateway's
    // parameters so a reload does not look like a fresh return from paying.
    function dropRazorpayParams() {
        try {
            var params = new URLSearchParams(window.location.search);
            RAZORPAY_PARAMS.forEach(function (name) { params.delete(name); });
            var search = params.toString();
            window.history.replaceState(null, '', window.location.pathname + (search ? '?' + search : '') + window.location.hash);
        } catch (e) { /* ignore */ }
    }

    function load() {
        if (!TOKEN) {
            showInvalid('This page opens an application from the link in your admissions email. Please open the most recent email from us and use the link in it, or contact the school office for help.');
            return;
        }
        if (!TOKEN_SHAPE.test(TOKEN)) {
            showInvalid(null);
            return;
        }

        showOnly(el.loading);
        var returning = hasRazorpayReturn();
        var gatewaySaid = String(query.get('razorpay_payment_link_status') || '').toLowerCase();

        // Back from paying: ask the gateway first, so the page opens on the real answer.
        var request = returning
            ? call('POST', '/payment/check').catch(function (error) {
                if (error.status === 404 || error.offline) throw error;
                return call('GET', '');
            })
            : call('GET', '');

        request.then(function (data) {
            state.data = data;
            state.lastCheck = Date.now();
            render();
            showOnly(el.view);
            if (returning) {
                dropRazorpayParams();
                announceGatewayReturn(data, gatewaySaid);
            }
        }).catch(function (error) {
            if (error.status === 404) showInvalid(error.message);
            else showOffline(error.offline ? null : error.message);
        });
    }

    function announceGatewayReturn(data, gatewaySaid) {
        var slot = document.getElementById('paymentSlot');
        var payment = data.payment;
        if (!slot || !payment) return;
        if (payment.status === 'VERIFIED') {
            setAlert(slot, 'success', 'Thank you. Your payment has been received and confirmed.');
        } else if (gatewaySaid === 'paid') {
            setAlert(slot, 'info', 'Thank you for paying. We are waiting for the payment provider to confirm it, which usually takes a minute. Press “I have paid — check status” again shortly.');
        } else {
            setAlert(slot, 'warn', 'The payment was not completed. You can try again with the Pay now button, or contact the school office if money has left your account.');
        }
        focusAlert(slot);
    }

    // After a 404 or 409 the page is out of date: reload it, then explain.
    function refreshWith(message) {
        call('GET', '').then(function (data) {
            state.data = data;
            render();
            var slot = document.getElementById('viewSlot');
            setAlert(slot, 'warn', message);
            focusAlert(slot);
        }, function (error) {
            if (error.status === 404) showInvalid(error.message);
            else {
                var slot = document.getElementById('viewSlot');
                setAlert(slot, 'error', message);
                focusAlert(slot);
            }
        });
    }

    function failed(error, slot, restore) {
        setBusy(false);
        if (restore) restore();
        if (error.status === 404 || error.status === 409) {
            refreshWith(error.message);
            return;
        }
        setAlert(slot, 'error', error.message);
        focusAlert(slot);
    }

    /* --- rendering ------------------------------------------------------------ */
    function chip(meta) {
        return h('span', { class: 'status-chip status-chip--' + meta.tone }, [icon(meta.icon), meta.label]);
    }

    function meta(label, value) {
        if (!value) return null;
        return h('div', null, [h('dt', { text: label }), h('dd', { text: value })]);
    }

    function slot(id) {
        return h('div', { class: 'status-slot', id: id || null, 'aria-live': 'polite' });
    }

    function render() {
        var data = state.data;
        var draft = readPaymentDraft();
        empty(el.view);
        append(el.view, [
            renderHeader(data),
            data.admitted ? renderAdmitted(data) : null,
            data.payment ? renderPayment(data) : null,
            data.documents && data.documents.length ? renderDocuments(data) : null,
            renderHelp(data)
        ]);
        restorePaymentDraft(draft);
        applyBusy();
    }

    /* header: who, which class, where it has got to */
    function renderHeader(d) {
        var stage = STAGE[d.status] || STAGE.NEW;
        return h('section', { class: 'admission-card status-card status-head', 'aria-labelledby': 'studentName' }, [
            h('div', { class: 'status-head-top' }, [
                h('div', { class: 'status-head-name' }, [
                    h('span', { class: 'eyebrow', text: 'Application for' }),
                    h('h2', { class: 'status-student', id: 'studentName', text: d.student_full_name || 'Your application' })
                ]),
                h('div', { class: 'status-ref' }, [h('small', { text: 'Reference' }), h('strong', { text: d.reference })])
            ]),
            h('dl', { class: 'status-meta' }, [
                meta('Class', d.class_name),
                meta('Academic year', d.academic_year_name),
                meta('Applied on', formatMoment(d.submitted_at, false))
            ]),
            h('div', { class: 'status-stage status-stage--' + stage[1] }, [
                h('span', { class: 'status-stage-icon' }, icon(stage[0])),
                h('div', null, [
                    h('h3', { id: 'stageTitle', tabindex: '-1', text: d.stage_title }),
                    h('p', { text: d.stage_message })
                ])
            ]),
            renderSteps(d.steps),
            slot('viewSlot')
        ]);
    }

    function renderSteps(steps) {
        if (!steps || !steps.length) return null;
        return h('ol', { class: 'step-track', 'aria-label': 'Application progress' }, steps.map(function (step, index) {
            var st = STEP_WORDS[step.state] ? step.state : 'upcoming';
            var marker = st === 'done' ? icon('fa-check') : st === 'stopped' ? icon('fa-xmark') : String(index + 1);
            return h('li', { class: 'step-track-item is-' + st, 'aria-current': st === 'current' ? 'step' : null }, [
                h('span', { class: 'step-track-marker' }, marker),
                h('span', { class: 'step-track-label' }, [
                    step.label,
                    h('span', { class: 'visually-hidden', text: ' (' + STEP_WORDS[st] + ')' })
                ])
            ]);
        }));
    }

    /* documents */
    function findDoc(key) {
        var docs = (state.data && state.data.documents) || [];
        for (var i = 0; i < docs.length; i++) if (docs[i].key === key) return docs[i];
        return null;
    }

    function docRow(key) {
        var rows = el.view.querySelectorAll('.doc-row');
        for (var i = 0; i < rows.length; i++) if (rows[i].getAttribute('data-doc') === key) return rows[i];
        return null;
    }

    function docSlot(key) {
        var row = docRow(key);
        return row ? row.querySelector('.status-slot') : document.getElementById('viewSlot');
    }

    function renderDocuments(d) {
        var canUpload = !!d.can_upload_documents;
        var card = h('section', { class: 'admission-card status-card', id: 'documentsCard', 'aria-labelledby': 'documentsHeading' }, [
            h('div', { class: 'form-section-head' }, [
                h('h2', { id: 'documentsHeading' }, [icon('fa-folder-open'), ' Documents']),
                h('p', {
                    text: canUpload
                        ? 'Upload a clear scan or photo of each document: PDF, JPG, PNG, WEBP or HEIC, up to ' + d.max_file_mb + ' MB per file.'
                        : 'The documents for this application and where each one has got to.'
                })
            ]),
            d.documents_note ? h('div', { class: 'status-note' }, [
                h('strong', { text: 'A note from the admissions office' }),
                h('p', { class: 'pre-line', text: d.documents_note })
            ]) : null,
            d.documents_deadline && formatDate(d.documents_deadline) ? h('p', { class: 'status-deadline' }, [
                icon('fa-calendar-day'),
                h('span', null, [canUpload ? 'Please upload by ' : 'Requested by ', h('strong', { text: formatDate(d.documents_deadline) })])
            ]) : null,
            h('ul', { class: 'doc-list' }, d.documents.map(function (doc) { return renderDocument(doc, d); })),
            canUpload ? renderDocumentActions(d) : null
        ]);
        return card;
    }

    function renderDocument(doc, d) {
        var status = DOC_STATUS[doc.status] ? doc.status : 'PENDING';
        var editable = !!d.can_upload_documents && status !== 'ACCEPTED' && status !== 'SUBMITTED';
        var files = doc.files || [];

        var review = null;
        if (doc.review_note && status === 'REJECTED') {
            review = h('div', { class: 'form-alert form-alert--error doc-review' }, [
                icon('fa-triangle-exclamation'),
                h('span', null, [h('strong', { text: 'Please upload this again. ' }), doc.review_note])
            ]);
        } else if (doc.review_note && status === 'UPLOADED') {
            review = h('div', { class: 'form-alert form-alert--info doc-review' }, [
                icon('fa-circle-info'),
                h('span', null, [h('strong', { text: 'Our earlier note: ' }), doc.review_note])
            ]);
        }

        return h('li', { class: 'doc-row doc-row--' + status.toLowerCase(), 'data-doc': doc.key }, [
            h('div', { class: 'doc-head' }, [
                h('div', { class: 'doc-title' }, [
                    h('h3', { text: doc.label }),
                    h('span', { class: 'doc-tag', text: doc.required ? 'Required' : 'Optional' })
                ]),
                chip(DOC_STATUS[status])
            ]),
            doc.description ? h('p', { class: 'doc-desc', text: doc.description }) : null,
            review,
            files.length
                ? h('ul', { class: 'file-list', 'aria-label': 'Files for ' + doc.label }, files.map(function (file) {
                    return renderFile(file, doc, editable);
                }))
                : (editable ? null : h('p', { class: 'doc-empty', text: 'No files uploaded.' })),
            editable ? renderUpload(doc, d, files.length) : null,
            slot(null)
        ]);
    }

    function renderFile(file, doc, editable) {
        var pdf = extension(file.name) === 'pdf';
        return h('li', { class: 'file-chip' + (editable ? '' : ' file-chip--fixed') }, [
            icon(pdf ? 'fa-file-pdf' : 'fa-file-image'),
            h('span', { class: 'file-name', title: file.name, text: file.name }),
            formatSize(file.size) ? h('span', { class: 'file-size', text: formatSize(file.size) }) : null,
            editable ? h('button', {
                type: 'button', class: 'file-remove', 'data-lock': true,
                'aria-label': 'Remove ' + file.name + ' from ' + doc.label,
                title: 'Remove',
                onclick: function () { removeFile(doc.key, file); }
            }, icon('fa-xmark')) : null
        ]);
    }

    function renderUpload(doc, d, count) {
        var max = Number(d.max_files_per_document) || 1;
        var remaining = Math.max(0, max - count);
        var hintId = 'hint-' + safeId(doc.key);
        var input = h('input', {
            type: 'file', accept: ACCEPT, multiple: max - count > 1 ? true : null,
            class: 'visually-hidden', tabindex: '-1', 'aria-hidden': 'true'
        });
        input.addEventListener('change', function () {
            var chosen = Array.prototype.slice.call(input.files || []);
            input.value = '';
            if (chosen.length) uploadFiles(doc.key, chosen);
        });

        var hint;
        if (!remaining) hint = 'This document has the most files allowed (' + max + '). Remove one to add another.';
        else if (max > 1) hint = 'PDF or photo, up to ' + d.max_file_mb + ' MB each. You can add ' + plural(remaining, 'more file') + '.';
        else hint = 'PDF or photo, up to ' + d.max_file_mb + ' MB.';

        return h('div', { class: 'doc-upload' }, [
            input,
            h('button', {
                type: 'button', class: 'btn btn--outline btn--sm', 'data-lock': true,
                'data-off': remaining ? null : true, 'data-upload': doc.key,
                'aria-label': (count ? 'Add another file to ' : 'Upload a file for ') + doc.label,
                'aria-describedby': hintId,
                onclick: function () { input.click(); }
            }, [icon('fa-cloud-arrow-up'), count ? ' Add another file' : ' Upload file']),
            h('span', { class: 'hint', id: hintId, text: hint })
        ]);
    }

    function missingRequired(d) {
        return (d.documents || []).filter(function (doc) {
            return doc.required && doc.status !== 'UPLOADED' && doc.status !== 'ACCEPTED';
        }).map(function (doc) { return doc.label; });
    }

    function renderDocumentActions(d) {
        var ready = !!d.can_submit_documents;
        var missing = missingRequired(d);
        var note;
        if (ready) note = 'When everything is uploaded, send the documents to our team. You will not be able to change them after submitting.';
        else if (missing.length) note = 'Still needed before you can submit: ' + missing.join(', ') + '.';
        else note = 'Upload at least one document to submit.';

        var submit = h('button', {
            type: 'button', class: 'btn btn--mint', id: 'submitDocs', 'data-lock': true,
            'data-off': ready ? null : true, 'aria-describedby': 'submitDocsNote'
        }, [icon('fa-paper-plane'), ' Submit for verification']);

        var yes = h('button', { type: 'button', class: 'btn btn--mint btn--sm', 'data-lock': true },
            [icon('fa-check'), ' Yes, submit']);
        var no = h('button', { type: 'button', class: 'btn btn--outline btn--sm', 'data-lock': true }, 'Not yet');
        var confirm = h('div', {
            class: 'confirm-panel is-hidden', role: 'group', 'aria-labelledby': 'confirmDocsText'
        }, [
            h('p', { id: 'confirmDocsText', text: 'You will not be able to change the documents after submitting. Send them to our team for verification now?' }),
            h('div', { class: 'confirm-actions' }, [yes, no])
        ]);
        var actionSlot = slot('docsSlot');

        submit.addEventListener('click', function () {
            setAlert(actionSlot, null);
            show(confirm);
            focusNode(yes);
        });
        no.addEventListener('click', function () {
            hide(confirm);
            submit.focus();
        });
        yes.addEventListener('click', function () { submitDocuments(yes, actionSlot); });

        return h('div', { class: 'doc-actions' }, [
            h('div', { class: 'form-actions' }, [
                h('p', { class: 'form-note', id: 'submitDocsNote', text: note }),
                submit
            ]),
            confirm,
            actionSlot
        ]);
    }

    /* payment */
    function renderPayment(d) {
        var p = d.payment;
        var status = PAY_STATUS[p.status] ? p.status : 'REQUESTED';
        var verified = status === 'VERIFIED';
        var closed = d.status === 'REJECTED';
        var payUrl = !verified && !closed ? safeUrl(p.link_url) : null;
        var gateway = p.provider === 'RAZORPAY';

        var children = [
            h('div', { class: 'form-section-head' }, [
                h('h2', { id: 'paymentHeading' }, [icon('fa-wallet'), ' ' + (p.description || 'Admission fee')]),
                h('p', { text: verified ? 'Thank you, the fee has been paid.' : 'The fee for this admission and how to pay it.' })
            ]),
            h('div', { class: 'pay-summary' }, [
                h('div', { class: 'pay-figure' }, [h('small', { text: 'Amount' }), h('strong', { class: 'pay-amount', text: money(p.amount, p.currency) })]),
                p.due_date && formatDate(p.due_date)
                    ? h('div', { class: 'pay-figure' }, [h('small', { text: verified ? 'Was due by' : 'Please pay by' }), h('strong', { text: formatDate(p.due_date) })])
                    : null,
                chip(PAY_STATUS[status])
            ])
        ];

        if (verified) {
            children.push(h('div', { class: 'form-alert form-alert--success pay-banner' }, [
                icon('fa-circle-check'), h('span', { text: 'The payment has been confirmed. Thank you.' })
            ]));
        } else if (status === 'REJECTED') {
            children.push(h('div', { class: 'form-alert form-alert--error pay-banner' }, [
                icon('fa-triangle-exclamation'),
                h('span', null, [
                    h('strong', { text: 'We could not confirm the payment details you sent. ' }),
                    p.review_note || 'Please check them and submit again, or contact the school office.'
                ])
            ]));
        }

        if (payUrl) {
            children.push(h('div', { class: 'pay-now' }, [
                h('a', { class: 'btn btn--mint btn--lg', href: payUrl, target: '_blank', rel: 'noopener noreferrer' },
                    [icon('fa-lock'), ' Pay now']),
                h('span', {
                    class: 'hint',
                    text: 'Opens a secure payment page in a new tab. ' + (gateway
                        ? 'Once you have paid, the payment is confirmed automatically.'
                        : 'Once you have paid, send us the transaction ID below.')
                })
            ]));
        }

        if (p.instructions && !verified) {
            children.push(h('div', { class: 'pay-instructions' }, [
                h('h3', { text: 'How to pay' }),
                h('p', { class: 'pre-line', text: p.instructions })
            ]));
        }

        if (gateway && !verified && d.can_submit_payment) {
            var check = h('button', {
                type: 'button', class: 'btn btn--outline btn--sm', id: 'checkPayment', 'data-lock': true
            }, [icon('fa-rotate'), ' I have paid — check status']);
            check.addEventListener('click', function () { checkPayment(check); });
            children.push(h('div', { class: 'pay-check' }, check));
        }

        children.push(slot('paymentSlot'));

        if (p.last_submission) children.push(renderLastSubmission(p));
        if (d.can_submit_payment) children.push(renderPaymentForm(d));

        return h('section', { class: 'admission-card status-card', id: 'paymentCard', 'aria-labelledby': 'paymentHeading' }, children);
    }

    function renderLastSubmission(p) {
        var s = p.last_submission;
        var subStatus = SUBMISSION_STATUS[s.status] ? s.status : 'PENDING';
        return h('div', { class: 'pay-last' }, [
            h('div', { class: 'pay-last-head' }, [
                h('h3', { text: 'The payment details you sent' }),
                chip(SUBMISSION_STATUS[subStatus])
            ]),
            h('dl', { class: 'status-meta' }, [
                meta('Transaction ID', s.transaction_id),
                meta('Paid on', formatDate(s.paid_on)),
                meta('Amount', s.amount ? money(s.amount, p.currency) : ''),
                meta('Screenshot or receipt', s.has_attachment ? 'Attached' : ''),
                meta('Sent on', formatMoment(s.submitted_at, true))
            ])
        ]);
    }

    function field(id, label, control, hint, optional) {
        return h('div', { class: 'form-field' }, [
            h('label', { for: id }, [label, optional ? h('span', { class: 'label-optional', text: ' (optional)' }) : null]),
            control,
            hint ? h('span', { class: 'hint', id: id + 'Hint', text: hint }) : null,
            h('span', { class: 'field-error', id: id + 'Error' })
        ]);
    }

    function renderPaymentForm(d) {
        var p = d.payment;
        var status = PAY_STATUS[p.status] ? p.status : 'REQUESTED';
        var openByDefault = status === 'REJECTED' || (p.provider !== 'RAZORPAY' && status === 'REQUESTED');
        var open = state.payFormOpen === null ? openByDefault : state.payFormOpen;
        var currency = String(p.currency || 'INR').toUpperCase();

        var method = h('select', { class: 'form-input', id: 'payMethod', name: 'method' },
            [h('option', { value: '', text: 'Choose one' })].concat(METHODS.map(function (m) {
                return h('option', { value: m[0], text: m[1] });
            })));

        var form = h('form', { class: 'pay-form' + (open ? '' : ' is-hidden'), id: 'payForm', novalidate: true, 'aria-labelledby': 'payFormHeading' }, [
            h('h3', { id: 'payFormHeading', text: 'Submit payment details' }),
            h('p', { class: 'pay-form-lead', text: 'Already paid? Enter the transaction ID (UTR or reference number) from your bank or UPI app, or attach a screenshot or PDF of the receipt, and our accounts team will confirm it.' }),
            h('div', { class: 'form-grid' }, [
                h('div', { class: 'form-row' }, [
                    field('payTransaction', 'Transaction ID / UTR',
                        h('input', { class: 'form-input', id: 'payTransaction', name: 'transaction_id', type: 'text', maxlength: '120', autocomplete: 'off', placeholder: 'e.g. 412345678901', 'aria-describedby': 'payTransactionHint payTransactionError' }),
                        'Needed unless you attach a screenshot below.'),
                    field('payDate', 'Date paid',
                        h('input', { class: 'form-input', id: 'payDate', name: 'paid_on', type: 'date', value: todayIso(), max: todayIso(), 'aria-describedby': 'payDateError' }))
                ]),
                h('div', { class: 'form-row' }, [
                    field('payAmount', 'Amount paid (' + currency + ')',
                        h('input', { class: 'form-input', id: 'payAmount', name: 'amount', type: 'number', inputmode: 'decimal', min: '0', step: '0.01', value: p.amount != null ? String(p.amount) : null, 'aria-describedby': 'payAmountError' })),
                    field('payMethod', 'How you paid', method, null, true)
                ]),
                field('payNote', 'Note for our accounts team',
                    h('textarea', { class: 'form-input', id: 'payNote', name: 'note', rows: '2', maxlength: '1000' }), null, true),
                field('payFile', 'Screenshot or receipt',
                    h('input', { class: 'form-input form-input--file', id: 'payFile', name: 'file', type: 'file', accept: ACCEPT, 'aria-describedby': 'payFileHint payFileError' }),
                    'PDF or image, up to ' + d.max_file_mb + ' MB.', true)
            ]),
            h('div', { class: 'form-alert form-alert--error is-hidden', id: 'payFormError', role: 'alert', tabindex: '-1' }),
            h('div', { class: 'form-actions' }, [
                h('p', { class: 'form-note', text: 'Our accounts team checks every payment and confirms it by email.' }),
                h('button', { type: 'submit', class: 'btn btn--mint', id: 'paySubmit', 'data-lock': true },
                    [icon('fa-paper-plane'), ' Submit payment details'])
            ])
        ]);
        form.addEventListener('submit', function (event) {
            event.preventDefault();
            submitPayment(form);
        });

        if (openByDefault && state.payFormOpen === null) return form;

        var pending = p.last_submission && p.last_submission.status === 'PENDING';
        var toggle = h('button', {
            type: 'button', class: 'link-btn pay-toggle', 'aria-expanded': open ? 'true' : 'false', 'aria-controls': 'payForm'
        }, [
            icon(open ? 'fa-minus' : 'fa-plus'),
            ' ' + (pending ? 'Send updated payment details'
                : p.provider === 'RAZORPAY' ? 'Paid another way? Send the payment details'
                    : 'Send the payment details')
        ]);
        toggle.addEventListener('click', function () {
            var nowOpen = form.classList.contains('is-hidden');
            state.payFormOpen = nowOpen;
            if (nowOpen) show(form); else hide(form);
            toggle.setAttribute('aria-expanded', nowOpen ? 'true' : 'false');
            var glyph = toggle.querySelector('i');
            if (glyph) glyph.className = 'fa-solid ' + (nowOpen ? 'fa-minus' : 'fa-plus');
            if (nowOpen) focusNode(document.getElementById('payTransaction'));
        });
        return h('div', { class: 'pay-form-wrap' }, [toggle, form]);
    }

    var DRAFT_FIELDS = ['payTransaction', 'payDate', 'payAmount', 'payMethod', 'payNote'];

    function readPaymentDraft() {
        if (!document.getElementById('payForm')) return null;
        var draft = {};
        DRAFT_FIELDS.forEach(function (id) {
            var node = document.getElementById(id);
            if (node) draft[id] = node.value;
        });
        return draft;
    }

    function restorePaymentDraft(draft) {
        if (!draft || state.dropDraft) { state.dropDraft = false; return; }
        DRAFT_FIELDS.forEach(function (id) {
            var node = document.getElementById(id);
            if (node && draft[id] !== undefined) node.value = draft[id];
        });
    }

    /* admitted */
    function renderAdmitted(d) {
        var a = d.admitted;
        var school = d.school || {};
        var web = safeUrl(school.web_app_url);
        var mobile = safeUrl(school.mobile_app_url);
        return h('section', { class: 'admission-card status-card admitted-card', 'aria-labelledby': 'admittedHeading' }, [
            h('div', { class: 'success-icon' }, icon('fa-graduation-cap')),
            h('h2', { id: 'admittedHeading', text: 'Congratulations!' }),
            h('p', {
                class: 'admitted-lead',
                text: (d.student_full_name || 'Your child') + ' is now a student' +
                    (school.name ? ' at ' + school.name : '') + '. We are delighted to welcome you.'
            }),
            h('dl', { class: 'status-meta status-meta--center' }, [
                meta('Class', a.class_name),
                meta('Academic year', a.academic_year_name),
                meta('Admission number', a.admission_number),
                meta('Login email', a.login_email)
            ]),
            a.login_email ? h('p', { class: 'status-small', text: 'The password for the learning app was sent to your email. Sign in with the login email above.' }) : null,
            web || mobile ? h('div', { class: 'status-actions' }, [
                web ? h('a', { class: 'btn btn--deep', href: web, target: '_blank', rel: 'noopener noreferrer' }, [icon('fa-globe'), ' Open the web app']) : null,
                mobile ? h('a', { class: 'btn btn--outline', href: mobile, target: '_blank', rel: 'noopener noreferrer' }, [icon('fa-mobile-screen-button'), ' Get the mobile app']) : null
            ]) : null
        ]);
    }

    /* help line */
    function renderHelp(d) {
        var school = d.school || {};
        var phone = String(school.contact_phone || '').trim();
        var email = String(school.contact_email || '').trim();
        var dial = phone.replace(/[^\d+]/g, '');
        var emailOk = /^[^\s@<>"']+@[^\s@<>"']+\.[^\s@<>"']+$/.test(email);
        if (!dial && !emailOk) {
            // The school has not filled in its contact details; use the office's.
            phone = '+91 92077 73300'; dial = '+919207773300';
            email = 'academics@h7ed.com'; emailOk = true;
        }
        return h('aside', { class: 'aside-card aside-contact status-help', 'aria-labelledby': 'helpHeading' }, [
            h('h3', { id: 'helpHeading', text: 'Questions about this application?' }),
            h('p', { class: 'status-help-lead' }, [
                'Contact ' + (school.name || 'the admissions office') + ' and quote the reference ',
                h('strong', { text: d.reference }), '.'
            ]),
            h('div', { class: 'status-help-links' }, [
                dial ? h('a', { href: 'tel:' + dial }, [icon('fa-phone'), ' ' + (phone || dial)]) : null,
                emailOk ? h('a', { href: 'mailto:' + email }, [icon('fa-envelope'), ' ' + email]) : null
            ])
        ]);
    }

    /* --- actions --------------------------------------------------------------- */
    function uploadFiles(key, chosen) {
        var d = state.data;
        var doc = findDoc(key);
        if (!doc || state.busy) return;
        var slotNode = docSlot(key);
        var max = Number(d.max_files_per_document) || 1;
        var limitMb = Number(d.max_file_mb) || 10;
        var remaining = Math.max(0, max - (doc.files || []).length);

        var problems = [];
        var good = chosen.filter(function (file) {
            if (EXTENSIONS.indexOf(extension(file.name)) === -1) {
                problems.push(file.name + ' is not a PDF or an image (JPG, PNG, WEBP or HEIC).');
                return false;
            }
            if (!file.size) {
                problems.push(file.name + ' is empty.');
                return false;
            }
            if (file.size > limitMb * 1024 * 1024) {
                problems.push(file.name + ' is larger than ' + limitMb + ' MB. Please choose a smaller scan or photo.');
                return false;
            }
            return true;
        });

        if (good.length > remaining) {
            setAlert(slotNode, 'error', doc.label + ' can have up to ' + plural(max, 'file') + '. ' +
                (remaining ? 'You can add ' + plural(remaining, 'more file') + ', so please choose fewer.'
                    : 'Remove one before adding another.'));
            focusAlert(slotNode);
            return;
        }
        if (!good.length) {
            setAlert(slotNode, 'error', problems.join(' '));
            focusAlert(slotNode);
            return;
        }

        setBusy(true);
        var done = 0;

        function next() {
            if (done >= good.length) return Promise.resolve();
            var file = good[done];
            setAlert(docSlot(key), 'info', 'Uploading ' +
                (good.length > 1 ? (done + 1) + ' of ' + good.length + ': ' : '') + file.name + '…', true);
            var body = new FormData();
            body.append('file', file, file.name);
            return call('POST', '/documents/' + encodeURIComponent(key), body).then(function (data) {
                state.data = data;
                done += 1;
                render();   // keeps state.busy, so every button stays locked until the end
                return next();
            });
        }

        next().then(function () {
            setBusy(false);
            var message = (done === 1 ? 'File uploaded.' : done + ' files uploaded.');
            if (problems.length) message += ' ' + problems.join(' ');
            else if (state.data.can_submit_documents) message += ' When everything is ready, press Submit for verification below.';
            var target = docSlot(key);
            setAlert(target, problems.length ? 'warn' : 'success', message);
            focusAlert(target);
        }, function (error) {
            var prefix = done ? done + ' of ' + good.length + ' files uploaded. ' : '';
            failed(new ErrorLike(error, prefix + good[done].name + ' could not be uploaded. ' + error.message), docSlot(key));
        });
    }

    // An error carrying the same status with a fuller message.
    function ErrorLike(error, message) {
        this.status = error.status;
        this.offline = error.offline;
        this.message = message;
    }

    function removeFile(key, file) {
        if (state.busy) return;
        var slotNode = docSlot(key);
        setBusy(true);
        setAlert(slotNode, 'info', 'Removing ' + file.name + '…', true);
        call('DELETE', '/documents/' + encodeURIComponent(key) + '/files/' + encodeURIComponent(file.id))
            .then(function (data) {
                state.data = data;
                state.busy = false;
                render();
                setAlert(docSlot(key), 'success', file.name + ' removed.');
                var row = docRow(key);
                var upload = row && row.querySelector('[data-upload]');
                focusNode(upload && !upload.disabled ? upload : docSlot(key).firstChild);
            }, function (error) { failed(error, docSlot(key)); });
    }

    function submitDocuments(button, actionSlot) {
        if (state.busy) return;
        setBusy(true);
        var restore = spinButton(button, 'Submitting…');
        call('POST', '/documents/submit').then(function (data) {
            state.data = data;
            state.busy = false;
            render();
            var top = document.getElementById('viewSlot');
            setAlert(top, 'success', 'Thank you. The documents have been sent to our team for verification. We will email you once they have been checked.');
            var title = document.getElementById('stageTitle');
            if (title) {
                title.scrollIntoView({ behavior: 'smooth', block: 'center' });
                try { title.focus({ preventScroll: true }); } catch (e) { title.focus(); }
            }
        }, function (error) { failed(error, actionSlot, restore); });
    }

    function checkPayment(button) {
        if (state.busy) return;
        var slotNode = document.getElementById('paymentSlot');
        setBusy(true);
        setAlert(slotNode, null);
        var restore = spinButton(button, 'Checking…');
        var wait = Math.max(0, CHECK_GAP_MS - (Date.now() - state.lastCheck));

        window.setTimeout(function () {
            call('POST', '/payment/check').then(function (data) {
                state.data = data;
                state.lastCheck = Date.now();
                state.busy = false;
                render();
                var target = document.getElementById('paymentSlot');
                if (data.payment && data.payment.status === 'VERIFIED') {
                    setAlert(target, 'success', 'Thank you. Your payment has been received and confirmed.');
                } else {
                    setAlert(target, 'info', 'We have not received confirmation of the payment yet. If you have just paid, please wait a minute and check again. If you paid another way, send us the payment details below.');
                }
                focusAlert(target);
            }, function (error) {
                state.lastCheck = Date.now();
                failed(error, slotNode, restore);
            });
        }, wait);
    }

    function markInvalid(id, message) {
        var input = document.getElementById(id);
        var wrap = input && input.closest('.form-field');
        if (!wrap) return;
        wrap.classList.add('is-invalid');
        input.setAttribute('aria-invalid', 'true');
        var note = document.getElementById(id + 'Error');
        if (note) note.textContent = message;
    }

    function setFormError(message) {
        var box = document.getElementById('payFormError');
        if (!box) return;
        empty(box);
        if (!message) { hide(box); return; }
        append(box, [icon('fa-triangle-exclamation'), h('span', { text: message })]);
        show(box);
    }

    function submitPayment(form) {
        if (state.busy) return;
        var d = state.data;
        Array.prototype.forEach.call(form.querySelectorAll('.form-field.is-invalid'), function (wrap) {
            wrap.classList.remove('is-invalid');
            var input = wrap.querySelector('[aria-invalid]');
            if (input) input.removeAttribute('aria-invalid');
        });
        setFormError(null);

        var transaction = document.getElementById('payTransaction').value.trim();
        var paidOn = document.getElementById('payDate').value;
        var amount = document.getElementById('payAmount').value.trim();
        var method = document.getElementById('payMethod').value;
        var note = document.getElementById('payNote').value.trim();
        var fileInput = document.getElementById('payFile');
        var file = fileInput.files && fileInput.files[0];
        var limitMb = Number(d.max_file_mb) || 10;

        var problems = [];
        if (!transaction && !file) {
            problems.push('payTransaction');
            markInvalid('payTransaction', 'Enter the transaction ID, or attach a screenshot below.');
        }
        if (paidOn && paidOn > todayIso()) {
            problems.push('payDate');
            markInvalid('payDate', 'The payment date cannot be in the future.');
        }
        if (amount && !(Number(amount) > 0)) {
            problems.push('payAmount');
            markInvalid('payAmount', 'Enter the amount you paid, or leave it blank.');
        }
        if (file) {
            if (EXTENSIONS.indexOf(extension(file.name)) === -1) {
                problems.push('payFile');
                markInvalid('payFile', 'Please attach a PDF or an image (JPG, PNG, WEBP or HEIC).');
            } else if (file.size > limitMb * 1024 * 1024) {
                problems.push('payFile');
                markInvalid('payFile', 'That file is larger than ' + limitMb + ' MB. Please attach a smaller screenshot.');
            } else if (!file.size) {
                problems.push('payFile');
                markInvalid('payFile', 'That file is empty. Please choose another.');
            }
        }
        if (problems.length) {
            setFormError(problems[0] === 'payTransaction' && problems.length === 1
                ? 'Enter the transaction ID, or attach a screenshot or PDF of the payment.'
                : 'Please check the highlighted fields.');
            focusNode(document.getElementById(problems[0]));
            return;
        }

        var body = new FormData();
        if (transaction) body.append('transaction_id', transaction);
        if (paidOn) body.append('paid_on', paidOn);
        if (amount) body.append('amount', amount);
        if (method) body.append('method', method);
        if (note) body.append('note', note);
        if (file) body.append('file', file, file.name);

        setBusy(true);
        var button = document.getElementById('paySubmit');
        var restore = spinButton(button, 'Sending…');
        call('POST', '/payment', body).then(function (data) {
            state.data = data;
            state.busy = false;
            state.payFormOpen = null;
            state.dropDraft = true;
            render();
            var target = document.getElementById('paymentSlot');
            setAlert(target, 'success', data.payment && data.payment.status === 'VERIFIED'
                ? 'Thank you. The payment has been confirmed.'
                : 'Thank you. We have received the payment details. Our accounts team will check them and confirm by email.');
            focusAlert(target);
        }, function (error) {
            setBusy(false);
            restore();
            if (error.status === 404 || error.status === 409) {
                refreshWith(error.message);
                return;
            }
            setFormError(error.message);
            focusNode(document.getElementById('payFormError'));
        });
    }

    /* --- boot ------------------------------------------------------------------- */
    if (el.retry) el.retry.addEventListener('click', load);
    load();
})();
