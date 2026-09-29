import { createSignal, For, onMount, Show } from 'solid-js';
import {
  type AccountInfo,
  deleteCurrentAccount,
  getAccount,
  signOutAccount,
  startSignIn,
} from '../lib/account';

type Provider = 'google' | 'github' | 'mock';

export default function AccountControls() {
  const [account, setAccount] = createSignal<AccountInfo | null>(null);
  const [error, setError] = createSignal('');
  const [busy, setBusy] = createSignal(false);

  onMount(() => {
    void getAccount()
      .then(setAccount)
      .catch(() => {
        if (navigator.onLine) setError('Could not load your account.');
      });
  });

  async function signIn(provider: Provider) {
    setBusy(true);
    setError('');
    try {
      await startSignIn(provider);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not sign in.');
      setBusy(false);
    }
  }

  async function signOut() {
    setBusy(true);
    setError('');
    try {
      await signOutAccount();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not sign out.');
      setBusy(false);
    }
  }

  async function removeAccount() {
    if (!window.confirm('Delete your account and all saved swipes?')) return;
    setBusy(true);
    setError('');
    try {
      await deleteCurrentAccount();
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : 'Could not delete account.',
      );
      setBusy(false);
    }
  }

  return (
    <Show when={account()}>
      {(current) => (
        <section class="account-section" id="account" aria-label="Account">
          <h2 class="label-voice">Account</h2>
          <Show
            when={!current().user.isAnonymous}
            fallback={
              <>
                <p class="body-voice">
                  Sign in to keep your Liked list across devices.
                </p>
                <Show
                  when={current().providers.length}
                  fallback={
                    <p class="caption-voice">
                      Sign-in is not available on this deployment yet.
                    </p>
                  }
                >
                  <div class="account-actions">
                    <For each={current().providers as Provider[]}>
                      {(provider) => (
                        <button
                          type="button"
                          class="label-voice"
                          disabled={busy()}
                          onClick={() => void signIn(provider)}
                        >
                          Continue with{' '}
                          {provider === 'google'
                            ? 'Google'
                            : provider === 'github'
                              ? 'GitHub'
                              : 'Test account'}
                        </button>
                      )}
                    </For>
                  </div>
                </Show>
              </>
            }
          >
            <p class="body-voice">Signed in as {current().user.name}</p>
            <div class="account-actions">
              <button
                type="button"
                class="label-voice"
                disabled={busy()}
                onClick={() => void signOut()}
              >
                Sign out
              </button>
              <button
                type="button"
                class="label-voice account-delete"
                disabled={busy()}
                onClick={() => void removeAccount()}
              >
                Delete account
              </button>
            </div>
          </Show>
          <Show when={error()}>
            <p class="inline-error body-voice" role="alert">
              {error()}
            </p>
          </Show>
        </section>
      )}
    </Show>
  );
}
