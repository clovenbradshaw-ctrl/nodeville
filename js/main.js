/* ==========================================================================
   Hyphae Mesh - Main JavaScript
   UI Interactions: Collapsibles, Copy Buttons, Wizard Navigation
   ========================================================================== */

(function() {
  'use strict';

  // Initialize on DOM ready
  document.addEventListener('DOMContentLoaded', init);

  function init() {
    initCollapsibles();
    initCopyButtons();
    initWizard();
    initTabs();
  }

  /* ==========================================================================
     Collapsible Info Boxes
     ========================================================================== */

  function initCollapsibles() {
    const infoBoxes = document.querySelectorAll('.info-box');

    infoBoxes.forEach(box => {
      const header = box.querySelector('.info-box-header');
      if (!header) return;

      header.addEventListener('click', () => {
        box.classList.toggle('open');
      });

      // Allow keyboard navigation
      header.setAttribute('tabindex', '0');
      header.setAttribute('role', 'button');
      header.setAttribute('aria-expanded', box.classList.contains('open'));

      header.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          box.classList.toggle('open');
          header.setAttribute('aria-expanded', box.classList.contains('open'));
        }
      });
    });
  }

  /* ==========================================================================
     Copy Buttons
     ========================================================================== */

  function initCopyButtons() {
    const copyBtns = document.querySelectorAll('.copy-btn');

    copyBtns.forEach(btn => {
      btn.addEventListener('click', async () => {
        const targetId = btn.dataset.copyTarget;
        const target = targetId
          ? document.getElementById(targetId)
          : btn.previousElementSibling;

        if (!target) return;

        const text = target.textContent || target.value;

        try {
          await navigator.clipboard.writeText(text.trim());
          showCopySuccess(btn);
        } catch (err) {
          // Fallback for older browsers
          fallbackCopy(text.trim());
          showCopySuccess(btn);
        }
      });
    });
  }

  function showCopySuccess(btn) {
    const originalText = btn.innerHTML;
    btn.classList.add('copied');
    btn.innerHTML = '✓ Copied';

    setTimeout(() => {
      btn.classList.remove('copied');
      btn.innerHTML = originalText;
    }, 2000);
  }

  function fallbackCopy(text) {
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.select();
    document.execCommand('copy');
    document.body.removeChild(textarea);
  }

  /* ==========================================================================
     Step Wizard Navigation
     ========================================================================== */

  function initWizard() {
    const wizard = document.querySelector('.wizard');
    if (!wizard) return;

    const steps = wizard.querySelectorAll('.step-content');
    const progressSteps = wizard.querySelectorAll('.wizard-step');
    const connectors = wizard.querySelectorAll('.wizard-connector');

    let currentStep = 0;

    // Bind next/back buttons
    wizard.querySelectorAll('[data-wizard-next]').forEach(btn => {
      btn.addEventListener('click', () => goToStep(currentStep + 1));
    });

    wizard.querySelectorAll('[data-wizard-back]').forEach(btn => {
      btn.addEventListener('click', () => goToStep(currentStep - 1));
    });

    // Allow clicking on completed steps
    progressSteps.forEach((step, index) => {
      step.addEventListener('click', () => {
        if (index < currentStep) {
          goToStep(index);
        }
      });
    });

    function goToStep(stepIndex) {
      if (stepIndex < 0 || stepIndex >= steps.length) return;

      // Update step content visibility
      steps.forEach((step, index) => {
        step.classList.toggle('active', index === stepIndex);
      });

      // Update progress indicators
      progressSteps.forEach((step, index) => {
        step.classList.remove('active', 'completed');
        if (index < stepIndex) {
          step.classList.add('completed');
        } else if (index === stepIndex) {
          step.classList.add('active');
        }
      });

      // Update connectors
      connectors.forEach((connector, index) => {
        connector.classList.toggle('active', index < stepIndex);
      });

      currentStep = stepIndex;

      // Scroll to top of wizard
      wizard.scrollIntoView({ behavior: 'smooth', block: 'start' });

      // Update URL hash for deep linking
      if (steps[currentStep].id) {
        history.replaceState(null, '', '#' + steps[currentStep].id);
      }
    }

    // Check for deep link on load
    if (window.location.hash) {
      const targetId = window.location.hash.slice(1);
      steps.forEach((step, index) => {
        if (step.id === targetId) {
          goToStep(index);
        }
      });
    }
  }

  /* ==========================================================================
     Tabs
     ========================================================================== */

  function initTabs() {
    const tabContainers = document.querySelectorAll('[data-tabs]');

    tabContainers.forEach(container => {
      const tabs = container.querySelectorAll('.tab');
      const contents = container.querySelectorAll('.tab-content');

      tabs.forEach((tab, index) => {
        tab.addEventListener('click', () => {
          // Deactivate all
          tabs.forEach(t => t.classList.remove('active'));
          contents.forEach(c => c.classList.remove('active'));

          // Activate clicked
          tab.classList.add('active');
          if (contents[index]) {
            contents[index].classList.add('active');
          }
        });
      });
    });
  }

  /* ==========================================================================
     Utility: Smooth scroll for anchor links
     ========================================================================== */

  document.querySelectorAll('a[href^="#"]').forEach(anchor => {
    anchor.addEventListener('click', function(e) {
      const targetId = this.getAttribute('href');
      if (targetId === '#') return;

      const target = document.querySelector(targetId);
      if (target) {
        e.preventDefault();
        target.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    });
  });

})();
