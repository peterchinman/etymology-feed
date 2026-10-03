import { children, type JSX, Show } from 'solid-js';
import HeartIcon from './HeartIcon';

type Props = {
  word: string;
  etymNo: number | null;
  likeCount?: number;
  tabIndex?: number;
  /** A control at the right end of the row, such as a like button. */
  action?: JSX.Element;
};

export default function CardFooter(props: Props) {
  // Resolve once: reading a JSX prop twice would create its element twice.
  const action = children(() => props.action);
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
      <div class="card-bottom-end">
        <Show when={(props.likeCount ?? 0) > 0}>
          <span class="card-like-count caption-voice">
            {/* A heart action beside the total already shows what it counts. */}
            <Show when={!action()}>
              <HeartIcon />
            </Show>
            <span class="sr-only">Liked by </span>
            <span>{props.likeCount?.toLocaleString()}</span>
            <span class="sr-only">
              {props.likeCount === 1 ? ' user' : ' users'}
            </span>
          </span>
        </Show>
        {action()}
      </div>
    </div>
  );
}
