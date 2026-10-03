type Props = { filled?: boolean; class?: string };

/** The app's heart. Filled marks a card the user has liked. */
export default function HeartIcon(props: Props) {
  return (
    <svg class={props.class} aria-hidden="true" viewBox="0 0 256 256">
      <path
        d="M128,224l89.36-90.64a50,50,0,1,0-70.72-70.72L128,80,109.36,62.64a50,50,0,0,0-70.72,70.72Z"
        fill={props.filled ? 'currentColor' : 'none'}
        stroke="currentColor"
        stroke-linecap="round"
        stroke-linejoin="round"
        stroke-width="16"
      />
    </svg>
  );
}
