"""Score a pipeline-produced portion CSV against a gold *_portion_weights.csv.

Both files use the schema:
  Video title, Track, Log number, Portion number, Target Weight (g), Weight (g), Heel/End, Notes

Matching is log-alignment-aware: gold logs and predicted logs are matched by
weight-content similarity (weights are near-unique), so a constant numbering
offset does not penalise. Reports:
  - recovered: gold rows matched exactly (track, portion, weight) after alignment
  - wrong_weight: matched (track, portion) but weight differs
  - missing: gold rows with no counterpart
  - spurious: predicted rows with no counterpart

Usage: python gt_eval.py <pred.csv> <gold.csv> [-v]
"""
import csv, sys, collections


def load(path):
    logs = collections.defaultdict(list)   # log -> [(track, pn, weight, heel, note)]
    with open(path, encoding='utf-8-sig', newline='') as f:
        for r in csv.DictReader(f):
            logs[int(r['Log number'])].append((
                int(r['Track']), int(r['Portion number']),
                round(float(r['Weight (g)']), 1),
                bool((r.get('Heel/End') or '').strip()),
                (r.get('Notes') or '').strip()))
    return dict(logs)


def sim(a, b):
    """Similarity between two logs = fraction of overlapping (track,pn)->weight agreeing."""
    da = {(t, p): w for t, p, w, _, _ in a}
    db = {(t, p): w for t, p, w, _, _ in b}
    common = set(da) & set(db)
    if not common:
        # fall back to weight-multiset overlap (handles pn offsets)
        wa = collections.Counter(w for _, _, w, _, _ in a)
        wb = collections.Counter(w for _, _, w, _, _ in b)
        inter = sum((wa & wb).values())
        return 0.5 * inter / max(1, min(sum(wa.values()), sum(wb.values())))
    return sum(1 for k in common if da[k] == db[k]) / len(common)


def align(pred, gold):
    """Greedy 1-1 alignment of predicted logs to gold logs by similarity."""
    pairs = []
    for g in gold:
        for p in pred:
            s = sim(pred[p], gold[g])
            if s > 0.3:
                pairs.append((s, len(set((t, q) for t, q, w, _, _ in pred[p]) &
                                     set((t, q) for t, q, w, _, _ in gold[g])), g, p))
    pairs.sort(key=lambda x: (-x[0], -x[1]))
    gm, pm, out = set(), set(), {}
    for s, _, g, p in pairs:
        if g in gm or p in pm:
            continue
        gm.add(g); pm.add(p); out[g] = p
    return out


def main():
    args = [a for a in sys.argv[1:] if not a.startswith('-')]
    verbose = '-v' in sys.argv
    pred, gold = load(args[0]), load(args[1])
    amap = align(pred, gold)

    offsets = collections.Counter(p - g for g, p in amap.items())
    recovered = wrong = missing = 0
    spurious_logs = [p for p in pred if p not in amap.values()]
    unmatched_gold = [g for g in gold if g not in amap]
    details = []

    matched_pred_rows = 0
    for g, rows in gold.items():
        p = amap.get(g)
        prow = {(t, q): w for t, q, w, _, _ in pred.get(p, [])} if p else {}
        for t, q, w, heel, note in rows:
            if (t, q) in prow:
                if prow[(t, q)] == w:
                    recovered += 1
                else:
                    wrong += 1
                    details.append(f"  WRONG  gold log {g} T{t} pn{q}: gold={w} pred={prow[(t,q)]}")
                matched_pred_rows += 1
            else:
                missing += 1
                details.append(f"  MISS   gold log {g} T{t} pn{q}: gold={w}{' (heel)' if heel else ''}")
    total_pred = sum(len(v) for v in pred.values())
    spurious = total_pred - matched_pred_rows
    total_gold = sum(len(v) for v in gold.values())

    print(f"gold rows      : {total_gold}  ({len(gold)} logs)")
    print(f"pred rows      : {total_pred}  ({len(pred)} logs)")
    print(f"logs aligned   : {len(amap)}   numbering offsets: {dict(offsets)}")
    print(f"recovered      : {recovered}  ({recovered/total_gold*100:.1f}%)")
    print(f"wrong weight   : {wrong}")
    print(f"missing        : {missing}")
    print(f"spurious pred  : {spurious}")
    if unmatched_gold:
        print(f"gold logs with no pred match: {unmatched_gold}")
    if spurious_logs:
        print(f"pred logs with no gold match: {spurious_logs}")
    if verbose and details:
        print('\n'.join(details[:80]))
    # machine-readable summary line
    print(f"SCORE recovered={recovered}/{total_gold} wrong={wrong} missing={missing} spurious={spurious}")


if __name__ == '__main__':
    main()
