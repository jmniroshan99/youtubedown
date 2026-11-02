type ProcessingMarkProps = {
  size?: "small" | "regular" | "large";
  active?: boolean;
};

// Decorative motion only: the adjacent live status describes real work.
export function ProcessingMark({
  size = "regular",
  active = true,
}: ProcessingMarkProps) {
  return (
    <span
      className={`processing-mark processing-mark--${size}${active ? " processing-mark--active" : ""}`}
      aria-hidden="true"
    >
      <img
        src="/favicon.svg?v=red-1"
        width={32}
        height={32}
        alt=""
        decoding="async"
      />
    </span>
  );
}
