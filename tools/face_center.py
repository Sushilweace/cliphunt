#!/usr/bin/env python3
"""Face center for one clip range. Prints JSON {"x":0..1,"y":0..1} of the largest face.
Usage: face_center.py video.mp4 start_seconds end_seconds
Needs: pip install opencv-python. Prints the frame center if OpenCV or a face is missing.
The Node renderer converts this frame position into an ffmpeg crop offset."""
import json, sys

def emit(x, y):
    print(json.dumps({"x": round(x, 3), "y": round(y, 3)}))

try:
    import cv2
except ImportError:
    emit(0.5, 0.5); sys.exit(0)

path, start, end = sys.argv[1], float(sys.argv[2]), float(sys.argv[3])
end = min(end, start + 30)
cap = cv2.VideoCapture(path)
cascade = cv2.CascadeClassifier(cv2.data.haarcascades + "haarcascade_frontalface_default.xml")
pts, weights = [], []
n = 8
span = max(end - start, 0.1)
for i in range(n):
    t = start + span * (i + 0.5) / n
    cap.set(cv2.CAP_PROP_POS_MSEC, t * 1000)
    ok, frame = cap.read()
    if not ok:
        continue
    h, w = frame.shape[:2]
    scale = 480.0 / max(w, 1)
    small = cv2.resize(frame, (int(w * scale), int(h * scale)))
    gray = cv2.cvtColor(small, cv2.COLOR_BGR2GRAY)
    faces = cascade.detectMultiScale(gray, 1.1, 5, minSize=(30, 30))
    if len(faces):
        x, y, fw, fh = max(faces, key=lambda f: f[2] * f[3])
        pts.append(((x + fw / 2) / small.shape[1], (y + fh / 2) / small.shape[0]))
        weights.append(fw * fh)
if pts:
    tw = sum(weights)
    emit(sum(p[0] * w for p, w in zip(pts, weights)) / tw, sum(p[1] * w for p, w in zip(pts, weights)) / tw)
else:
    emit(0.5, 0.5)
