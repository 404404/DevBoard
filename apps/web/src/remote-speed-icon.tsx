// Match Desktop's 16px bolt outline and filled state.
export function RemoteSpeedIcon({ active }: { active: boolean }) {
  return (
    <svg className="remote-speed-icon" aria-hidden="true" viewBox="0 0 16 16" fill="currentColor">
      <path
        d={
          active
            ? "M8.34278 1.71324C9.03756 1.01907 10.2544 1.67038 10.0137 2.66441L9.32715 5.49644H12.5938C13.5715 5.49644 14.1035 6.63914 13.4736 7.38707L7.72266 14.2162C7.04234 15.0231 5.73791 14.3622 5.98633 13.3363L6.67285 10.5043H3.40625C2.42855 10.5042 1.89667 9.36153 2.52637 8.61363L8.27735 1.78453L8.34278 1.71324Z"
            : "M8.34282 1.71275C9.03761 1.01858 10.2545 1.66989 10.0137 2.66392L9.3272 5.49595H12.5938C13.5716 5.49595 14.1035 6.63865 13.4737 7.38658L7.7227 14.2157C7.04238 15.0227 5.73784 14.3618 5.98638 13.3358L6.6729 10.5038H3.4063C2.42851 10.5038 1.89659 9.36106 2.52642 8.61314L8.27739 1.78404L8.34282 1.71275ZM3.32915 9.2899C3.2748 9.35494 3.32141 9.45396 3.4063 9.45396H7.02251C7.5244 9.45398 7.89369 9.9242 7.77544 10.412L7.05669 13.3758L12.6709 6.70982C12.7253 6.64478 12.6787 6.54576 12.5938 6.54576H8.97759C8.47569 6.54574 8.10641 6.07552 8.22466 5.58775L8.94243 2.62291L3.32915 9.2899Z"
        }
      />
    </svg>
  );
}
function particleSeed(index: number, salt: number) {
  const value = Math.sin((index + 1) * 12.9898 + salt * 78.233) * 43758.5453;
  return value - Math.floor(value);
}
const particles = Array.from({ length: 14 }, (_, index) => {
  const duration = 1.9 / (1 + (particleSeed(index, 21) - 0.5) * 0.4);
  return {
    duration,
    delay: (index * 1.9) / 14 - duration,
    top: 12 + particleSeed(index, 23) * 76,
    opacity: 0.4 + particleSeed(index, 11) * 0.6,
    scale: 0.5 + particleSeed(index, 12) * 0.45,
  };
});
export function RemoteSpeedParticles() {
  return (
    <span className="remote-speed-particles" aria-hidden="true">
      {particles.map((particle, index) => (
        <span
          key={index}
          className="remote-speed-particle-path"
          style={{
            animationDuration: `${particle.duration}s`,
            animationDelay: `${particle.delay}s`,
            top: `${particle.top}%`,
          }}
        >
          <span
            style={{
              opacity: particle.opacity,
              transform: `translate(-50%, -50%) scale(${particle.scale})`,
            }}
          />
        </span>
      ))}
    </span>
  );
}
