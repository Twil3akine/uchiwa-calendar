export function classifyTouchGesture(
  dx: number,
  dy: number,
  longPressed: boolean,
  moved: boolean,
  landedOnDay: boolean,
): "next-month" | "previous-month" | "range" | "held" | "tap";

export function startTouchGesture(options: {
  target: EventTarget;
  touchId: number;
  startX: number;
  startY: number;
  anchor: string;
  findDay(x: number, y: number): string | undefined;
  onPreview(anchor: string | null, end: string | null): void;
  onCreate(anchor: string, end: string): void;
  onNavigateMonth(direction: -1 | 1): void;
  onSuppressClick(): void;
  onFinish?: () => void;
  setTimer?: (callback: () => void, delay: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (timer: ReturnType<typeof setTimeout>) => void;
}): () => void;
