import { Show } from 'solid-js';

type Props = {
  word: string;
  etymNo: number | null;
  likeCount?: number;
  tabIndex?: number;
};

export default function CardFooter(props: Props) {
  return (
    <div class="card-bottom">
      <a
        class="entry-link caption-voice"
        href={`https://en.wiktionary.org/wiki/${encodeURIComponent(props.word)}${props.etymNo ? `#Etymology_${props.etymNo}` : ''}`}
        target="_blank"
        rel="noopener noreferrer"
        title={`View ${props.word} on Wiktionary`}
        tabindex={props.tabIndex}
      >
        Wiktionary
      </a>
      <Show when={(props.likeCount ?? 0) > 0}>
        <span class="card-like-count caption-voice">
          <svg aria-hidden="true" viewBox="0 0 256 256">
            <path
              d="M128,224l89.36-90.64a50,50,0,1,0-70.72-70.72L128,80,109.36,62.64a50,50,0,0,0-70.72,70.72Z"
              fill="none"
              stroke="currentColor"
              stroke-linecap="round"
              stroke-linejoin="round"
              stroke-width="16"
            />
          </svg>
          <span class="sr-only">Liked by </span>
          <span>{props.likeCount?.toLocaleString()}</span>
          <span class="sr-only">
            {props.likeCount === 1 ? ' user' : ' users'}
          </span>
        </span>
      </Show>
    </div>
  );
}
