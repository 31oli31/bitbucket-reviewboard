#!/usr/bin/env python3
"""Generate the ReviewBoard toolbar icons (no external dependencies).

The design is intentionally simple so it stays readable at 16x16:
a dark rounded square with a bright review check mark.

Usage: python3 scripts/make-icons.py
"""

from __future__ import annotations

import math
import struct
import zlib
from pathlib import Path

SIZES = (16, 32, 48, 128)
SUPERSAMPLE = 4

BG = (11, 18, 32)          # #0B1220
BORDER = (56, 189, 248)    # #38BDF8 (subtle rim)
CHECK = (52, 211, 153)     # #34D399
CHECK_DARK = (16, 185, 129)  # #10B981

# Normalized check mark geometry (x, y in 0..1).
CHECK_POINTS = ((0.27, 0.53), (0.44, 0.70), (0.75, 0.33))


def sdf_rounded_rect(x: float, y: float, half: float, radius: float, border: float) -> float:
    """Signed distance to a rounded square centered in the unit square."""
    dx = abs(x - 0.5) - (half - radius)
    dy = abs(y - 0.5) - (half - radius)
    outside = math.hypot(max(dx, 0.0), max(dy, 0.0))
    inside = min(max(dx, dy), 0.0)
    return outside + inside - radius - border


def distance_to_segment(px: float, py: float, ax: float, ay: float, bx: float, by: float) -> float:
    vx, vy = bx - ax, by - ay
    wx, wy = px - ax, py - ay
    length_sq = vx * vx + vy * vy
    t = 0.0 if length_sq == 0 else max(0.0, min(1.0, (wx * vx + wy * vy) / length_sq))
    return math.hypot(px - (ax + t * vx), py - (ay + t * vy))


def sample(x: float, y: float) -> tuple[float, float, float, float]:
    """Return premultiplied RGBA for one sub-pixel sample."""
    if sdf_rounded_rect(x, y, 0.46, 0.20, 0.0) > 0:
        return (0.0, 0.0, 0.0, 0.0)

    # Rim, keeping the icon crisp against light and dark toolbars.
    if sdf_rounded_rect(x, y, 0.46, 0.20, 0.018) > -0.012:
        r, g, b = BORDER
        return (r / 255, g / 255, b / 255, 0.55)

    thickness = 0.072
    distance = min(
        distance_to_segment(x, y, *CHECK_POINTS[0], *CHECK_POINTS[1]),
        distance_to_segment(x, y, *CHECK_POINTS[1], *CHECK_POINTS[2]),
    )
    if distance <= thickness:
        # Slight vertical gradient for depth.
        t = max(0.0, min(1.0, (y - 0.3) / 0.45))
        r = CHECK[0] * (1 - t) + CHECK_DARK[0] * t
        g = CHECK[1] * (1 - t) + CHECK_DARK[1] * t
        b = CHECK[2] * (1 - t) + CHECK_DARK[2] * t
        return (r / 255, g / 255, b / 255, 1.0)

    r, g, b = BG
    return (r / 255, g / 255, b / 255, 1.0)


def render(size: int) -> bytes:
    rows = bytearray()
    step = 1.0 / (size * SUPERSAMPLE)
    total = SUPERSAMPLE * SUPERSAMPLE

    for py in range(size):
        rows.append(0)  # PNG filter: none
        for px in range(size):
            acc_r = acc_g = acc_b = acc_a = 0.0
            for sy in range(SUPERSAMPLE):
                for sx in range(SUPERSAMPLE):
                    x = (px * SUPERSAMPLE + sx + 0.5) * step
                    y = (py * SUPERSAMPLE + sy + 0.5) * step
                    r, g, b, a = sample(x, y)
                    acc_r += r * a
                    acc_g += g * a
                    acc_b += b * a
                    acc_a += a

            alpha = acc_a / total
            if alpha <= 0.0001:
                rows.extend((0, 0, 0, 0))
                continue
            rows.extend(
                (
                    round(min(255, max(0, acc_r / total / alpha * 255))),
                    round(min(255, max(0, acc_g / total / alpha * 255))),
                    round(min(255, max(0, acc_b / total / alpha * 255))),
                    round(min(255, alpha * 255)),
                )
            )

    def chunk(tag: bytes, payload: bytes) -> bytes:
        return (
            struct.pack(">I", len(payload))
            + tag
            + payload
            + struct.pack(">I", zlib.crc32(tag + payload) & 0xFFFFFFFF)
        )

    header = struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)
    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", header)
        + chunk(b"IDAT", zlib.compress(bytes(rows), 9))
        + chunk(b"IEND", b"")
    )


def main() -> None:
    root = Path(__file__).resolve().parent.parent
    out_dir = root / "icons"
    out_dir.mkdir(exist_ok=True)

    for size in SIZES:
        path = out_dir / f"icon-{size}.png"
        path.write_bytes(render(size))
        print(f"wrote {path.relative_to(root)} ({path.stat().st_size} bytes)")


if __name__ == "__main__":
    main()
