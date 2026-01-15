/**
 * Loading state management utilities
 */

/**
 * Show loading spinner in an element
 */
export function showLoadingSpinner(element: HTMLElement | null, text: string = 'Loading...'): void {
  if (!element) return;
  
  const originalContent = element.innerHTML;
  element.dataset.originalContent = originalContent;
  element.innerHTML = `
    <span class="spinner"></span>
    <span class="loading-text">${text}</span>
  `;
  element.classList.add('loading');
}

/**
 * Hide loading spinner and restore original content
 */
export function hideLoadingSpinner(element: HTMLElement | null): void {
  if (!element) return;
  
  const originalContent = element.dataset.originalContent;
  if (originalContent !== undefined) {
    element.innerHTML = originalContent;
    delete element.dataset.originalContent;
  }
  element.classList.remove('loading');
}

/**
 * Set button loading state
 */
export function setButtonLoading(button: HTMLButtonElement | null, isLoading: boolean, loadingText: string = 'Loading...'): void {
  if (!button) return;
  
  if (isLoading) {
    button.disabled = true;
    button.dataset.originalText = button.textContent || '';
    button.innerHTML = `
      <span class="spinner spinner-small"></span>
      <span>${loadingText}</span>
    `;
    button.classList.add('btn-loading');
  } else {
    button.disabled = false;
    const originalText = button.dataset.originalText;
    if (originalText !== undefined) {
      button.textContent = originalText;
      delete button.dataset.originalText;
    }
    button.classList.remove('btn-loading');
  }
}

/**
 * Show loading overlay
 */
export function showLoadingOverlay(container: HTMLElement | null, message: string = 'Loading...'): void {
  if (!container) return;
  
  let overlay = container.querySelector('.loading-overlay') as HTMLElement;
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.className = 'loading-overlay';
    container.appendChild(overlay);
  }
  
  overlay.innerHTML = `
    <div class="loading-overlay-content">
      <div class="spinner spinner-large"></div>
      <p>${message}</p>
    </div>
  `;
  overlay.style.display = 'flex';
}

/**
 * Hide loading overlay
 */
export function hideLoadingOverlay(container: HTMLElement | null): void {
  if (!container) return;
  
  const overlay = container.querySelector('.loading-overlay') as HTMLElement;
  if (overlay) {
    overlay.style.display = 'none';
  }
}

/**
 * Show progress indicator
 */
export function showProgress(container: HTMLElement | null, current: number, total: number, label: string = ''): void {
  if (!container) return;
  
  let progressBar = container.querySelector('.progress-bar') as HTMLElement;
  if (!progressBar) {
    progressBar = document.createElement('div');
    progressBar.className = 'progress-bar';
    container.appendChild(progressBar);
  }
  
  const percentage = Math.round((current / total) * 100);
  progressBar.innerHTML = `
    <div class="progress-bar-fill" style="width: ${percentage}%"></div>
    <div class="progress-bar-text">${label || `${current} / ${total}`}</div>
  `;
  progressBar.style.display = 'block';
}

/**
 * Hide progress indicator
 */
export function hideProgress(container: HTMLElement | null): void {
  if (!container) return;
  
  const progressBar = container.querySelector('.progress-bar') as HTMLElement;
  if (progressBar) {
    progressBar.style.display = 'none';
  }
}
