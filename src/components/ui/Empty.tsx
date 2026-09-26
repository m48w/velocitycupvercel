export function Empty({ text }: { text: string }) {
  return (
    <div className="empty-state">
      <span>◌</span>
      {text}
    </div>
  );
}
