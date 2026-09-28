import { createSignal, onCleanup, onMount, Show } from 'solid-js';
import Settings from './Settings';

export default function SettingsDialog() {
  let dialog!: HTMLDialogElement;
  const [active, setActive] = createSignal(false);
  const show = () => {
    if (dialog.open) return;
    setActive(true);
    dialog.showModal();
  };

  onMount(() => {
    const trigger = document.querySelector<HTMLAnchorElement>(
      '[data-settings-dialog-trigger]',
    );
    const open = (event: MouseEvent) => {
      if (!window.matchMedia('(min-width: 48.001rem)').matches) return;
      event.preventDefault();
      show();
    };
    trigger?.addEventListener('click', open);

    if (new URLSearchParams(window.location.search).has('settings')) {
      if (window.matchMedia('(max-width: 48rem)').matches) {
        window.location.replace('/settings/');
      } else {
        show();
      }
    }

    onCleanup(() => trigger?.removeEventListener('click', open));
  });

  const close = () => {
    setActive(false);
    const url = new URL(window.location.href);
    if (url.searchParams.has('settings')) {
      url.searchParams.delete('settings');
      window.history.replaceState(null, '', url);
    }
  };

  return (
    <dialog
      class="settings-dialog"
      ref={dialog}
      aria-label="Settings"
      onClose={close}
    >
      <Show when={active()}>
        <Settings variant="panel" onClose={() => dialog.close()} />
      </Show>
    </dialog>
  );
}
