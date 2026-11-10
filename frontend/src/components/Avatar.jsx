// GitHub avatar (decorative: the login is always shown or announced next to it).
export default function Avatar({ user, size = 24 }) {
  if (!user?.avatar_url) {
    return (
      <span
        aria-hidden="true"
        style={{ width: size, height: size }}
        className="inline-flex shrink-0 items-center justify-center rounded-full bg-cg-hover text-cg-xs text-cg-secondary"
      >
        {(user?.login || '?').slice(0, 1).toUpperCase()}
      </span>
    );
  }
  return (
    <img
      src={`${user.avatar_url}${user.avatar_url.includes('?') ? '&' : '?'}s=${size * 2}`}
      alt=""
      width={size}
      height={size}
      className="shrink-0 rounded-full border border-cg-border"
    />
  );
}
