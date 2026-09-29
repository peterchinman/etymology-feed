import { createSignal, onCleanup, onMount, Show } from 'solid-js';

type Props = {
  text: string;
  id: string;
  label: string;
  className: string;
};

export default function ExpandableText(props: Props) {
  const [expanded, setExpanded] = createSignal(false);
  const [overflows, setOverflows] = createSignal(false);
  let wrapper!: HTMLDivElement;
  let paragraph!: HTMLParagraphElement;

  onMount(() => {
    const measure = () => {
      const style = getComputedStyle(paragraph);
      const lines = Number.parseInt(
        style.getPropertyValue('--preview-lines'),
        10,
      );
      const lineHeight = Number.parseFloat(style.lineHeight);
      setOverflows(paragraph.scrollHeight > lineHeight * lines + 1);
    };
    const observer = new ResizeObserver(measure);
    // The wrapper changes width at the mobile breakpoint even while the
    // clamped paragraph stays the same height.
    observer.observe(wrapper);
    document.fonts.addEventListener('loadingdone', measure);
    measure();
    onCleanup(() => {
      observer.disconnect();
      document.fonts.removeEventListener('loadingdone', measure);
    });
  });

  return (
    <div
      ref={wrapper}
      class={`liked-preview reading-voice ${props.className}`}
      classList={{ 'is-collapsed': !expanded() && overflows() }}
    >
      <p
        ref={paragraph}
        id={props.id}
        class="reading-voice"
        classList={{ 'is-clamped': !expanded() }}
      >
        {props.text}
      </p>
      <Show when={overflows()}>
        <button
          class="definition-toggle label-voice"
          type="button"
          aria-controls={props.id}
          aria-expanded={expanded()}
          aria-label={`${expanded() ? 'See less' : 'See more'} ${props.label}`}
          onClick={() => setExpanded(!expanded())}
        >
          {expanded() ? 'See less' : 'See more'}
        </button>
      </Show>
    </div>
  );
}
