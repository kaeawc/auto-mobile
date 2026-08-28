<style>
  .md-content__inner > h1:first-child { display: none; }

  .desktop-demo-placeholder {
    align-items: center;
    background:
      linear-gradient(135deg, rgba(98, 0, 238, 0.22), rgba(3, 169, 244, 0.18)),
      var(--md-code-bg-color);
    border: 1px dashed var(--md-default-fg-color--lighter);
    border-radius: 1rem;
    display: flex;
    height: min(54vw, 28rem);
    justify-content: center;
    margin: 1rem 0 2rem;
  }

  .desktop-demo-placeholder svg {
    color: var(--md-default-fg-color--light);
    height: 30%;
    max-width: 10rem;
    width: 30%;
  }

  .desktop-downloads {
    display: grid;
    gap: 1rem;
    grid-template-columns: repeat(auto-fit, minmax(9rem, 1fr));
    margin: 1rem auto;
    max-width: 36rem;
  }

  .desktop-downloads a {
    align-items: center;
    background: var(--md-code-bg-color);
    border: 1px solid var(--md-default-fg-color--lighter);
    border-radius: 0.75rem;
    color: var(--md-default-fg-color);
    display: flex;
    flex-direction: column;
    gap: 0.2rem;
    justify-content: center;
    min-height: 4.5rem;
    padding: 0.75rem 1rem;
    text-decoration: none;
    transition: border-color 125ms ease, transform 125ms ease;
  }

  .desktop-downloads a:hover {
    border-color: var(--md-accent-fg-color);
    transform: translateY(-2px);
  }

  .desktop-downloads strong {
    font-size: 1rem;
  }

  .desktop-downloads span {
    color: var(--md-default-fg-color--light);
    font-size: 0.75rem;
  }
</style>

<div class="desktop-demo-placeholder" aria-label="AutoMobile Desktop App demo placeholder">
  <svg viewBox="0 0 128 96" aria-hidden="true">
    <rect x="8" y="8" width="112" height="72" rx="8" fill="none" stroke="currentColor" stroke-width="6"/>
    <path d="M45 88h38M64 80v8M48 30l36 14-36 14z" fill="currentColor"/>
  </svg>
</div>

<div class="desktop-downloads">
  <a href="https://github.com/kaeawc/auto-mobile/releases/download/0.0.66/AutoMobile-0.0.66-macos.dmg" aria-label="Download AutoMobile Desktop App for macOS x86-64">
    <strong>macOS</strong>
    <span>x86_64 · DMG</span>
  </a>
  <a href="https://github.com/kaeawc/auto-mobile/releases/download/0.0.66/AutoMobile-0.0.66-linux.deb" aria-label="Download AutoMobile Desktop App for Linux x86-64">
    <strong>Linux</strong>
    <span>x86_64 · DEB</span>
  </a>
  <a href="https://github.com/kaeawc/auto-mobile/releases/download/0.0.66/AutoMobile-0.0.66-windows.msi" aria-label="Download AutoMobile Desktop App for Windows x86-64">
    <strong>Windows</strong>
    <span>x86_64 · MSI</span>
  </a>
</div>
