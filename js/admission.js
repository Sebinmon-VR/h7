/* H7 EdTech — admission request form.
   Loads the classes and session from the LMS API, checks the form, sends it,
   and shows the reference number. Everything the page needs to know about the
   API is the data-api attribute on the <form>. */
(function () {
    'use strict';

    var form = document.getElementById('admissionForm');
    if (!form) return;

    var query = new URLSearchParams(window.location.search);
    var apiOrigin = (query.get('api') || form.getAttribute('data-api') || '').replace(/\/+$/, '');
    var API = apiOrigin + '/api/v1';
    var PROGRAM = form.getAttribute('data-program') || 'LMS';

    var el = {
        card: document.getElementById('formCard'),
        status: document.getElementById('formStatus'),
        error: document.getElementById('formError'),
        success: document.getElementById('formSuccess'),
        successMessage: document.getElementById('successMessage'),
        successReference: document.getElementById('successReference'),
        successTrack: document.getElementById('successTrack'),
        submitAnother: document.getElementById('submitAnother'),
        submit: document.getElementById('submitBtn'),
        classSelectField: document.getElementById('classSelectField'),
        classSelect: document.getElementById('class_id'),
        classTextField: document.getElementById('classTextField'),
        classText: document.getElementById('class_applied'),
        yearField: document.getElementById('yearField'),
        yearSelect: document.getElementById('academic_year_id'),
        yearText: document.getElementById('academic_year_name'),
        addSecond: document.getElementById('addSecondParent'),
        second: document.getElementById('secondParent'),
        removeSecond: document.getElementById('removeSecondParent'),
        dob: document.getElementById('date_of_birth'),
        consent: document.getElementById('consent'),
        consentField: document.getElementById('consentField'),
        consentError: document.getElementById('consentError')
    };

    var accepting = true;
    var classesLoaded = false;
    var submitLabel = el.submit.innerHTML;

    /* --- small helpers ------------------------------------------------------ */
    function show(node) { if (node) node.classList.remove('is-hidden'); }
    function hide(node) { if (node) node.classList.add('is-hidden'); }
    function text(name) {
        var field = form.elements[name];
        return field ? String(field.value || '').trim() : '';
    }
    function orNull(value) { return value ? value : null; }
    function escapeHtml(value) {
        return String(value).replace(/[&<>"']/g, function (c) {
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
        });
    }

    function setStatus(kind, html) {
        if (!kind) { hide(el.status); el.status.className = 'is-hidden'; return; }
        el.status.className = 'form-alert form-alert--' + kind;
        el.status.innerHTML = html;
        show(el.status);
    }

    function setError(html) {
        if (!html) { hide(el.error); el.error.innerHTML = ''; return; }
        el.error.innerHTML = '<i class="fa-solid fa-triangle-exclamation"></i><span>' + html + '</span>';
        show(el.error);
    }

    function fieldFor(path) {
        return form.querySelector('[data-field="' + path + '"]');
    }

    function markInvalid(input, message) {
        if (!input) return;
        if (input === el.consent) {
            el.consentField.classList.add('is-invalid');
            el.consentError.textContent = message;
            el.consentError.style.display = 'block';
            return;
        }
        var wrap = input.closest('.form-field');
        if (!wrap) return;
        wrap.classList.add('is-invalid');
        var note = wrap.querySelector('.field-error');
        if (note) note.textContent = message;
    }

    function clearInvalid() {
        Array.prototype.forEach.call(form.querySelectorAll('.form-field.is-invalid'), function (wrap) {
            wrap.classList.remove('is-invalid');
        });
        el.consentField.classList.remove('is-invalid');
        el.consentError.style.display = 'none';
        setError(null);
    }

    function setBusy(busy) {
        el.submit.disabled = busy;
        el.submit.innerHTML = busy
            ? '<i class="fa-solid fa-circle-notch fa-spin"></i> Sending…'
            : submitLabel;
    }

    function disableForm() {
        Array.prototype.forEach.call(form.querySelectorAll('input, select, textarea, button'), function (node) {
            node.disabled = true;
        });
    }

    /* --- what the form offers ----------------------------------------------- */
    function useTypedClass() {
        hide(el.classSelectField);
        show(el.classTextField);
        el.classSelect.removeAttribute('required');
        el.classText.setAttribute('required', 'required');
        classesLoaded = false;
    }

    function fillClasses(classes) {
        if (!classes || !classes.length) { useTypedClass(); return; }
        el.classSelect.innerHTML = '<option value="">Choose a class</option>';
        classes.forEach(function (room) {
            var option = document.createElement('option');
            option.value = String(room.id);
            option.textContent = room.name || room.code || ('Class ' + room.id);
            el.classSelect.appendChild(option);
        });
        show(el.classSelectField);
        hide(el.classTextField);
        classesLoaded = true;
    }

    function fillYears(data) {
        var years = data.academic_years || [];
        var chosen = data.academic_year;
        if (!years.length) { hide(el.yearField); return; }

        if (years.length === 1) {
            hide(el.yearSelect);
            show(el.yearText);
            el.yearText.value = years[0].name;
            el.yearSelect.innerHTML = '<option value="' + years[0].id + '" selected></option>';
        } else {
            show(el.yearSelect);
            hide(el.yearText);
            el.yearSelect.innerHTML = '';
            years.forEach(function (year) {
                var option = document.createElement('option');
                option.value = String(year.id);
                option.textContent = year.name;
                if (chosen && chosen.id === year.id) option.selected = true;
                el.yearSelect.appendChild(option);
            });
        }
        show(el.yearField);
    }

    function loadOptions() {
        setStatus('info', '<i class="fa-solid fa-circle-notch fa-spin"></i><span>Loading the admission form…</span>');
        fetch(API + '/admissions/requests/options?program=' + encodeURIComponent(PROGRAM), {
            headers: { Accept: 'application/json' }
        })
            .then(function (res) {
                if (!res.ok) throw new Error('HTTP ' + res.status);
                return res.json();
            })
            .then(function (data) {
                fillClasses(data.classes);
                fillYears(data);
                if (data.accepting === false) {
                    accepting = false;
                    setStatus('warn', '<i class="fa-solid fa-circle-info"></i><span>' +
                        escapeHtml(data.closed_reason || 'Admissions are closed at the moment.') +
                        ' You can still <a href="https://wa.me/message/5RN3H5SBER4TK1" target="_blank" rel="noopener noreferrer">message us on WhatsApp</a> or call the office.</span>');
                    disableForm();
                } else {
                    setStatus(null);
                }
            })
            .catch(function () {
                // The form still works without the class list; the office reads the class
                // the family typed.
                useTypedClass();
                hide(el.yearField);
                setStatus('warn', '<i class="fa-solid fa-circle-info"></i><span>We could not load the class list just now. Type the class below and send the application as usual.</span>');
            });
    }

    /* --- the second parent block -------------------------------------------- */
    function secondParentVisible() { return !el.second.classList.contains('is-hidden'); }

    el.addSecond.addEventListener('click', function () {
        show(el.second);
        hide(el.addSecond);
        document.getElementById('parent2_name').focus();
    });

    el.removeSecond.addEventListener('click', function () {
        Array.prototype.forEach.call(el.second.querySelectorAll('input'), function (input) { input.value = ''; });
        hide(el.second);
        show(el.addSecond);
        el.addSecond.focus();
    });

    /* --- checking the form -------------------------------------------------- */
    var EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

    function digits(value) { return value.replace(/\D/g, ''); }

    function validate() {
        var problems = [];
        function need(path, ok, message) { if (!ok) problems.push({ path: path, message: message }); }

        need('student_full_name', text('student_full_name').length >= 2, 'Enter the student’s full name.');

        var dob = text('date_of_birth');
        var today = new Date().toISOString().slice(0, 10);
        need('date_of_birth', !!dob, 'Enter the date of birth.');
        if (dob) need('date_of_birth', dob < today, 'The date of birth must be in the past.');

        if (classesLoaded) need('class_id', !!text('class_id'), 'Choose the class the student is applying for.');
        else need('class_applied', !!text('class_applied'), 'Tell us which class the student is applying for.');

        need('parents.0.full_name', !!text('parent1_name'), 'Enter the parent or guardian’s name.');
        need('parents.0.phone', digits(text('parent1_phone')).length >= 7, 'Enter a mobile number we can call.');
        need('parents.0.email', EMAIL.test(text('parent1_email')), 'Enter a valid email address.');

        if (secondParentVisible()) {
            var anySecond = ['parent2_name', 'parent2_phone', 'parent2_email', 'parent2_occupation'].some(function (n) { return !!text(n); });
            if (anySecond) {
                need('parents.1.full_name', !!text('parent2_name'), 'Enter this person’s name, or remove them.');
                if (text('parent2_email')) need('parents.1.email', EMAIL.test(text('parent2_email')), 'Enter a valid email address.');
                if (text('parent2_phone')) need('parents.1.phone', digits(text('parent2_phone')).length >= 7, 'Enter a valid mobile number.');
            }
        }

        need('consent', el.consent.checked, 'Please tick the declaration to continue.');

        problems.forEach(function (p) { markInvalid(fieldFor(p.path), p.message); });
        if (problems.length) {
            setError('Please check the highlighted fields.');
            var first = fieldFor(problems[0].path);
            if (first) {
                first.scrollIntoView({ behavior: 'smooth', block: 'center' });
                try { first.focus({ preventScroll: true }); } catch (e) { first.focus(); }
            }
        }
        return problems.length === 0;
    }

    function buildPayload() {
        var parents = [{
            relation: text('parent1_relation') || 'GUARDIAN',
            full_name: text('parent1_name'),
            phone: text('parent1_phone'),
            email: text('parent1_email'),
            occupation: orNull(text('parent1_occupation')),
            is_primary: true
        }];

        if (secondParentVisible() && text('parent2_name')) {
            parents.push({
                relation: text('parent2_relation') || 'GUARDIAN',
                full_name: text('parent2_name'),
                phone: orNull(text('parent2_phone')),
                email: orNull(text('parent2_email')),
                occupation: orNull(text('parent2_occupation')),
                is_primary: false
            });
        }

        var yearId = el.yearField.classList.contains('is-hidden') ? '' : text('academic_year_id');

        return {
            student_full_name: text('student_full_name'),
            date_of_birth: text('date_of_birth'),
            gender: orNull(text('gender')),
            blood_group: orNull(text('blood_group')),
            nationality: orNull(text('nationality')),
            previous_school: orNull(text('previous_school')),
            previous_class: orNull(text('previous_class')),
            class_id: classesLoaded && text('class_id') ? Number(text('class_id')) : null,
            class_applied: classesLoaded ? null : orNull(text('class_applied')),
            academic_year_id: yearId ? Number(yearId) : null,
            syllabus: orNull(text('syllabus')),
            medium: orNull(text('medium')),
            parents: parents,
            address_line1: orNull(text('address_line1')),
            address_line2: orNull(text('address_line2')),
            city: orNull(text('city')),
            state: orNull(text('state')),
            postal_code: orNull(text('postal_code')),
            country: orNull(text('country')),
            sibling_name: orNull(text('sibling_name')),
            transport_required: !!form.elements.transport_required.checked,
            medical_notes: orNull(text('medical_notes')),
            message: orNull(text('message')),
            how_heard: orNull(text('how_heard')),
            consent: !!el.consent.checked,
            website: text('website'),
            source: 'website'
        };
    }

    /* --- sending ------------------------------------------------------------ */
    function describeFailure(status, data) {
        var detail = data && data.detail;

        if (status === 422 && Array.isArray(detail)) {
            var general = [];
            detail.forEach(function (item) {
                var loc = (item.loc || []).filter(function (part) { return part !== 'body'; });
                var input = loc.length ? fieldFor(loc.join('.')) : null;
                var message = String(item.msg || '').replace(/^Value error,\s*/i, '');
                if (input) markInvalid(input, message);
                else general.push(message);
            });
            setError(general.length ? escapeHtml(general.join(' ')) : 'Please check the highlighted fields.');
            return;
        }

        if (typeof detail === 'string' && detail) {
            setError(escapeHtml(detail));
            return;
        }
        setError('Something went wrong on our side. Please try again in a moment, or contact the office.');
    }

    function showSuccess(data) {
        el.successReference.textContent = data.reference || '';
        el.successMessage.textContent = data.detail ||
            'Thank you. Our admissions team will review the application and get back to you.';
        // The acknowledgement email carries the family's private tracking link.
        if (el.successTrack) {
            if (data.acknowledgement_sent) show(el.successTrack); else hide(el.successTrack);
        }
        hide(el.card);
        show(el.success);
        el.success.scrollIntoView({ behavior: 'smooth', block: 'start' });
        try { el.success.focus({ preventScroll: true }); } catch (e) { /* ignore */ }
    }

    form.addEventListener('submit', function (event) {
        event.preventDefault();
        if (!accepting) return;
        clearInvalid();
        if (!validate()) return;

        setBusy(true);
        fetch(API + '/admissions/requests?program=' + encodeURIComponent(PROGRAM), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
            body: JSON.stringify(buildPayload())
        })
            .then(function (res) {
                return res.json().catch(function () { return null; }).then(function (data) {
                    return { status: res.status, data: data };
                });
            })
            .then(function (result) {
                if (result.status === 201 && result.data) {
                    showSuccess(result.data);
                } else {
                    describeFailure(result.status, result.data);
                    el.error.scrollIntoView({ behavior: 'smooth', block: 'center' });
                }
            })
            .catch(function () {
                setError('We could not reach the admissions server. Check your connection and try again, or contact the office.');
            })
            .then(function () { setBusy(false); });
    });

    el.submitAnother.addEventListener('click', function () {
        form.reset();
        clearInvalid();
        hide(el.second);
        show(el.addSecond);
        hide(el.success);
        show(el.card);
        window.scrollTo({ top: 0, behavior: 'smooth' });
    });

    /* --- boot ---------------------------------------------------------------- */
    el.dob.max = new Date().toISOString().slice(0, 10);
    loadOptions();
})();
