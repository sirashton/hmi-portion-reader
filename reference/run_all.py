"""Run the pipeline on every gold video and score each against its gold CSV.

Usage: python run_all.py [--step 2] [--only NamePart]
"""
import argparse, os, subprocess, sys, re

HERE = os.path.dirname(os.path.abspath(__file__))
VIDS = os.path.normpath(os.path.join(HERE, '..', '..', 'Portion Trial Vids'))
TARGETS = {  # from the gold CSVs' Target column
    'T1_Control': 776, 'T1_ControlB': 667, 'T1_NarrowControlRange': 667,
    'T1_RasherRange7': 667, 'T1_React10A': 667, 'T1_React10B': 667,
}

ap = argparse.ArgumentParser()
ap.add_argument('--step', default='2')
ap.add_argument('--only', default=None)
a = ap.parse_args()

summary = []
for name, target in TARGETS.items():
    if a.only and a.only.lower() not in name.lower():
        continue
    video = os.path.join(VIDS, name + '.mp4')
    gold = os.path.join(VIDS, name + '_portion_weights.csv')
    pred = os.path.join(HERE, 'pred_' + name + '.csv')
    print(f'=== {name} ===', flush=True)
    subprocess.run([sys.executable, '-u', os.path.join(HERE, 'read_video.py'),
                    video, '--target', str(target), '--step', a.step,
                    '--out', pred], check=True)
    r = subprocess.run([sys.executable, os.path.join(HERE, 'gt_eval.py'),
                        pred, gold], capture_output=True, text=True)
    print(r.stdout, flush=True)
    m = re.search(r'SCORE (.+)', r.stdout)
    summary.append(f'{name:26s} {m.group(1) if m else "?"}')

print('==== SUMMARY ====')
print('\n'.join(summary))
