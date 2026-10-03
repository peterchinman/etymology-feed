"""Build the §6.5 report locally from D1 table exports and the release DB."""

import argparse
import json
import sqlite3
from datetime import datetime, timedelta, timezone
from pathlib import Path


DIMENSIONS = ("bucket", "etymBand", "shape", "tier", "hasSignal")
TOP_RATERS = 20
MINUTE_MS = 60_000


def counter():
    return {"likes": 0, "total": 0}


def day_bucket():
    return {"total": counter(), **{name: {} for name in DIMENSIONS}}


def add(groups, key, liked):
    item = groups.setdefault(key, counter())
    item["total"] += 1
    item["likes"] += int(liked)


def summarize(days):
    total = day_bucket()
    for day in days:
        total["total"]["likes"] += day["total"]["likes"]
        total["total"]["total"] += day["total"]["total"]
        for dimension in DIMENSIONS:
            for key, item in day[dimension].items():
                result = total[dimension].setdefault(key, counter())
                result["likes"] += item["likes"]
                result["total"] += item["total"]
    total["globalLikeRate"] = rate(total["total"])
    for dimension in DIMENSIONS:
        total[dimension] = {
            key: {**item, "likeRate": rate(item)}
            for key, item in sorted(total[dimension].items())
        }
    return total


def rate(item):
    return item["likes"] / item["total"] if item["total"] else None


def peak_per_minute(times):
    """Most swipes inside any 60-second span of the client's swipe times."""
    peak = 0
    first = 0
    for last, time in enumerate(times):
        while time - times[first] >= MINUTE_MS:
            first += 1
        peak = max(peak, last - first + 1)
    return peak


def rater_report(connection, start, end):
    """The biggest contributors to word_stats, for review before flagging (§6.6)."""
    counted_total = connection.execute(
        "SELECT COUNT(*) FROM swipe WHERE tally = 1 AND received_at >= ? AND received_at < ?",
        (start, end),
    ).fetchone()[0]
    statuses = dict(connection.execute("SELECT user_id, status FROM rater"))
    rows = connection.execute(
        """SELECT user_id, COUNT(*), SUM(tally = 1), SUM(dealt = 1),
                  SUM(dealt = 1 AND verdict = 1)
           FROM swipe WHERE received_at >= ? AND received_at < ?
           GROUP BY user_id
           ORDER BY SUM(tally = 1) DESC, COUNT(*) DESC, user_id
           LIMIT ?""",
        (start, end, TOP_RATERS),
    ).fetchall()
    top = []
    for user_id, received, counted, dealt, dealt_likes in rows:
        times = [
            row[0]
            for row in connection.execute(
                "SELECT swiped_at FROM swipe WHERE user_id = ? "
                "AND received_at >= ? AND received_at < ? ORDER BY swiped_at",
                (user_id, start, end),
            )
        ]
        top.append(
            {
                "userId": user_id,
                "status": statuses.get(user_id),
                "received": received,
                "counted": counted,
                "shareOfCounted": counted / counted_total if counted_total else None,
                "dealt": dealt,
                "dealtLikeRate": dealt_likes / dealt if dealt else None,
                "peakPerMinute": peak_per_minute(times),
            }
        )
    return {
        "status": dict(
            connection.execute("SELECT status, COUNT(*) FROM rater GROUP BY status ORDER BY status")
        ),
        "countedSwipes": counted_total,
        "top": top,
    }


def make_report(connection, now=None, min_ratings=5, confirm_score=0.55, park_looks=15):
    now = now or datetime.now(timezone.utc)
    today = now.date()
    dates = [today - timedelta(days=offset) for offset in range(29, -1, -1)]
    days = {date.isoformat(): day_bucket() for date in dates}
    start = int(datetime.combine(dates[0], datetime.min.time(), timezone.utc).timestamp() * 1000)
    end = int(datetime.combine(today + timedelta(days=1), datetime.min.time(), timezone.utc).timestamp() * 1000)
    missing_cards = 0
    rows = connection.execute(
        """SELECT s.verdict, s.bucket, s.received_at, s.tally,
                  w.etym_band, w.shape, w.tier, w.has_signal
           FROM swipe AS s LEFT JOIN dictionary.word AS w ON w.id = s.card_id
           WHERE s.received_at >= ? AND s.received_at < ?""",
        (start, end),
    )
    received = {date: 0 for date in days}
    for verdict, bucket, received_at, tally, band, shape, tier, signal in rows:
        date = datetime.fromtimestamp(received_at / 1000, timezone.utc).date().isoformat()
        received[date] += 1
        # Rates describe only verdicts that count toward word_stats: held,
        # paced-out and flagged swipes would skew the tuning in §6.5.
        if tally != 1:
            continue
        day = days[date]
        liked = verdict == 1
        day["total"]["total"] += 1
        day["total"]["likes"] += int(liked)
        add(day["bucket"], bucket or "unrecorded", liked)
        if band is None:
            missing_cards += 1
            continue
        add(day["etymBand"], band, liked)
        for value in shape.split(","):
            add(day["shape"], value, liked)
        add(day["tier"], tier, liked)
        add(day["hasSignal"], str(signal), liked)

    ordered = list(days.values())
    seven = summarize(ordered[-7:])
    thirty = summarize(ordered)
    # Lane populations (§6.1): how many cards each lane could draw from today.
    rated = connection.execute(
        "SELECT COUNT(*) FROM word_stats WHERE likes + dislikes >= ?",
        (min_ratings,),
    ).fetchone()[0]
    confirmed = connection.execute(
        "SELECT COUNT(*) FROM word_stats WHERE likes + dislikes >= ? AND score >= ?",
        (min_ratings, confirm_score),
    ).fetchone()[0]
    promising = connection.execute(
        "SELECT COUNT(*) FROM word_stats WHERE likes > 0 "
        "AND (likes + dislikes < ? OR score < ?) AND (likes + dislikes < ? OR score >= 0.5)",
        (min_ratings, confirm_score, park_looks),
    ).fetchone()[0]
    fresh = connection.execute(
        "SELECT COUNT(*) FROM word_stats WHERE likes = 0 AND likes + dislikes < ?",
        (min_ratings,),
    ).fetchone()[0]
    never_seen = connection.execute(
        "SELECT COUNT(*) FROM word_stats WHERE likes + dislikes = 0"
    ).fetchone()[0]
    parked = connection.execute(
        "SELECT COUNT(*) FROM word_stats WHERE (likes = 0 AND likes + dislikes >= ?) "
        "OR (likes > 0 AND likes + dislikes >= ? AND score < 0.5)",
        (min_ratings, park_looks),
    ).fetchone()[0]
    # The DISLIKE_WEIGHT at which the average card scores 0.5 (§6.2).
    like_rate = thirty["globalLikeRate"]
    suggested_weight = (
        like_rate / (1 - like_rate) if like_rate is not None and 0 < like_rate < 1 else None
    )
    release = connection.execute(
        "SELECT value FROM dictionary.meta WHERE key = 'source_release'"
    ).fetchone()
    return {
        "generatedAt": now.isoformat(),
        "throughDateUtc": today.isoformat(),
        "dictionaryRelease": release[0] if release else None,
        "globalLikeRate": thirty["globalLikeRate"],
        "suggestedDislikeWeight": suggested_weight,
        "periods": {"7": seven, "30": thirty},
        "ratedCards": rated,
        "lanes": {
            "confirmed": confirmed,
            "promising": promising,
            "fresh": fresh,
            "neverSeen": never_seen,
            "parked": parked,
        },
        "missingDictionaryRows": missing_cards,
        "swipesPerDay": [
            {"date": date, "count": received[date], "counted": days[date]["total"]["total"]}
            for date in reversed(list(days))
        ],
        "raters": rater_report(connection, start, end),
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--swipes-sql", type=Path, required=True)
    parser.add_argument("--word-stats-sql", type=Path, required=True)
    parser.add_argument("--raters-sql", type=Path, help="data-only export of the rater table")
    parser.add_argument("--dict-db", type=Path, required=True)
    parser.add_argument("--min-ratings", type=int, default=5)
    parser.add_argument("--confirm-score", type=float, default=0.55)
    parser.add_argument("--park-looks", type=int, default=15)
    args = parser.parse_args()
    if args.park_looks < args.min_ratings:
        parser.error("--park-looks must be at least --min-ratings")
    if args.min_ratings < 1:
        parser.error("--min-ratings must be positive")
    if not 0.5 <= args.confirm_score < 1:
        parser.error("--confirm-score must be in [0.5, 1)")

    # ATTACH below uses a read-only file URI. Enable URI handling explicitly;
    # SQLite builds differ in whether it is enabled by default.
    connection = sqlite3.connect(":memory:", uri=True)
    try:
        # Data-only table exports avoid copying Better Auth users and sessions.
        swipe_columns = (
            "id TEXT, user_id TEXT, card_id TEXT, verdict INTEGER, "
            "bucket TEXT, shown_at INTEGER, swiped_at INTEGER, received_at INTEGER"
        )
        connection.executescript(
            f"CREATE TABLE swipe ({swipe_columns}, dealt INTEGER, tally INTEGER);"
            "CREATE TABLE word_stats (card_id TEXT, likes INTEGER, dislikes INTEGER, "
            "prior REAL, score REAL, updated_at INTEGER, pool_order TEXT);"
            "CREATE TABLE rater (user_id TEXT, status TEXT, rated INTEGER, liked INTEGER, "
            "credit REAL, credit_at INTEGER, revision TEXT, updated_at INTEGER);"
        )
        swipes_sql = args.swipes_sql.read_text(encoding="utf-8")
        try:
            connection.executescript(swipes_sql)
        except sqlite3.OperationalError as error:
            # Exports before rater trust have eight values per swipe. Every
            # one of those swipes was dealt and counted.
            if "table swipe has 10 columns but 8 values were supplied" not in str(error):
                raise
            connection.executescript(f"DROP TABLE swipe; CREATE TABLE swipe ({swipe_columns});")
            connection.executescript(swipes_sql)
            connection.executescript(
                "ALTER TABLE swipe ADD COLUMN dealt INTEGER NOT NULL DEFAULT 1;"
                "ALTER TABLE swipe ADD COLUMN tally INTEGER NOT NULL DEFAULT 1;"
            )
        if args.raters_sql:
            connection.executescript(args.raters_sql.read_text(encoding="utf-8"))
        stats_sql = args.word_stats_sql.read_text(encoding="utf-8")
        try:
            connection.executescript(stats_sql)
        except sqlite3.OperationalError as error:
            # Data-only exports before the pool-order migration use six
            # positional values. Keep those historical reports readable too.
            if "table word_stats has 7 columns but 6 values were supplied" not in str(error):
                raise
            connection.executescript(
                "DROP TABLE word_stats;"
                "CREATE TABLE word_stats (card_id TEXT, likes INTEGER, dislikes INTEGER, "
                "prior REAL, score REAL, updated_at INTEGER);"
            )
            connection.executescript(stats_sql)
        dictionary_uri = args.dict_db.resolve().as_uri() + "?mode=ro"
        connection.execute("ATTACH DATABASE ? AS dictionary", (dictionary_uri,))
        report = make_report(
            connection,
            min_ratings=args.min_ratings,
            confirm_score=args.confirm_score,
            park_looks=args.park_looks,
        )
        print(json.dumps(report, indent=2))
    finally:
        connection.close()


if __name__ == "__main__":
    main()
