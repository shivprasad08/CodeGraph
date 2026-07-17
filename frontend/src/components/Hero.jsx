import React, { useEffect, useRef } from "react";
import { motion } from "framer-motion";
import { ArrowRight } from "lucide-react";

const fadeUpVariants = {
  hidden: { opacity: 0, y: 30 },
  visible: (i) => ({
    opacity: 1,
    y: 0,
    transition: {
      duration: 1,
      delay: 0.5 + i * 0.2,
      ease: [0.25, 0.4, 0.25, 1],
    },
  }),
};

function Hero({ onAnalyze }) {
  const canvasRef = useRef(null);
  const [repoUrl, setRepoUrl] = React.useState('');
  const [urlError, setUrlError] = React.useState('');

  function handleAnalyze() {
    const trimmed = repoUrl.trim();
    if (!trimmed) { setUrlError('Enter a GitHub URL'); return; }
    if (!trimmed.includes('github.com')) {
      setUrlError('Must be a github.com URL'); return;
    }
    setUrlError('');
    onAnalyze?.(trimmed);
  }

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");

    let animationFrameId;
    let particles = [];

    const mouse = {
      x: null,
      y: null,
      radius: 150,
    };

    const handleMouseMove = (e) => {
      mouse.x = e.clientX;
      mouse.y = e.clientY;
    };

    const handleMouseLeave = () => {
      mouse.x = null;
      mouse.y = null;
    };

    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseleave", handleMouseLeave);

    const resizeCanvas = () => {
      canvas.width = window.innerWidth;
      canvas.height = window.innerHeight;
      init();
    };

    class Particle {
      constructor() {
        this.x = Math.random() * canvas.width;
        this.y = Math.random() * canvas.height;
        this.size = Math.random() * 2 + 0.5;
        this.speedX = (Math.random() * 0.6) - 0.3;
        this.speedY = (Math.random() * 0.6) - 0.3;
        this.opacity = Math.random() * 0.5 + 0.2;

        let color = `rgba(${
          ['124, 58, 237', '99, 102, 241', '59, 130, 246', '34, 197, 94', '245, 158, 11']
          [Math.floor(Math.random() * 5)]
        }, ${Math.random() * 0.4 + 0.5})`;
        this.color = color;
      }

      update() {
        this.x += this.speedX;
        this.y += this.speedY;

        if (mouse.x !== null && mouse.y !== null) {
          const dx = mouse.x - this.x;
          const dy = mouse.y - this.y;
          const distance = Math.sqrt(dx * dx + dy * dy);
          if (distance < mouse.radius) {
            const force = (mouse.radius - distance) / mouse.radius;
            const angle = Math.atan2(dy, dx);
            this.x -= Math.cos(angle) * force * 2;
            this.y -= Math.sin(angle) * force * 2;
          }
        }

        if (this.x < 0 || this.x > canvas.width) this.speedX *= -1;
        if (this.y < 0 || this.y > canvas.height) this.speedY *= -1;

        this.x = Math.max(0, Math.min(canvas.width, this.x));
        this.y = Math.max(0, Math.min(canvas.height, this.y));
      }

      draw() {
        ctx.beginPath();
        ctx.arc(this.x, this.y, this.size, 0, Math.PI * 2);
        ctx.fillStyle = this.color;
        ctx.fill();
      }
    }

    function init() {
      particles = [];
      const numberOfParticles = Math.min(
        Math.floor((canvas.width * canvas.height) / 6000),
        120
      );
      for (let i = 0; i < numberOfParticles; i++) {
        particles.push(new Particle());
      }
    }

    function connect() {
      const maxDistance = 150;

      for (let a = 0; a < particles.length; a++) {
        for (let b = a + 1; b < particles.length; b++) {
          const dx = particles[a].x - particles[b].x;
          const dy = particles[a].y - particles[b].y;
          const distanceSquared = dx * dx + dy * dy;
          const maxSquared = maxDistance * maxDistance;

          if (distanceSquared < maxSquared) {
            const distance = Math.sqrt(distanceSquared);
            const opacity = (1 - distance / maxDistance) * 0.7;

            // check if either particle is near the mouse
            const dxMouseA = particles[a].x - (mouse.x ?? -9999);
            const dyMouseA = particles[a].y - (mouse.y ?? -9999);
            const distMouse = Math.sqrt(dxMouseA * dxMouseA + dyMouseA * dyMouseA);

            if (mouse.x !== null && distMouse < mouse.radius) {
              ctx.strokeStyle = `rgba(200, 180, 255, ${opacity})`;
              ctx.lineWidth = 1.2;
            } else {
              ctx.strokeStyle = `rgba(124, 58, 237, ${opacity * 0.8})`;
              ctx.lineWidth = 0.8;
            }

            ctx.beginPath();
            ctx.moveTo(particles[a].x, particles[a].y);
            ctx.lineTo(particles[b].x, particles[b].y);
            ctx.stroke();
          }
        }
      }
    }

    function animate() {
      animationFrameId = requestAnimationFrame(animate);
      ctx.fillStyle = '#0a0a0f';
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      connect();   // draw edges first (behind nodes)

      for (let i = 0; i < particles.length; i++) {
        particles[i].update();   // then draw nodes on top
        particles[i].draw();
      }
    }

    resizeCanvas();
    window.addEventListener("resize", resizeCanvas);
    animate();

    return () => {
      window.removeEventListener("resize", resizeCanvas);
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseleave", handleMouseLeave);
      cancelAnimationFrame(animationFrameId);
    };
  }, []);

  return (
    <div className="relative min-h-[calc(100vh-3.5rem)] flex items-center justify-center overflow-hidden">
      <canvas
        ref={canvasRef}
        className="absolute inset-0 w-full h-full"
        style={{ zIndex: 0 }}
      />

      <div className="relative z-10 flex flex-col items-center text-center px-4 w-full">
        {/* Badge */}
        <motion.div
          custom={0}
          variants={fadeUpVariants}
          initial="hidden"
          animate="visible"
          className="inline-flex items-center gap-2 px-4 py-1.5 rounded-full bg-purple-500/10 border border-purple-500/20 mb-6 backdrop-blur-sm"
        >
          <span className="w-1.5 h-1.5 rounded-full bg-purple-400 animate-pulse" />
          <span className="text-sm font-mono text-purple-300 tracking-widest uppercase">
            Open Source · Free · No Signup
          </span>
        </motion.div>

        {/* Headline */}
        <motion.h1
          custom={1}
          variants={fadeUpVariants}
          initial="hidden"
          animate="visible"
          className="text-5xl md:text-7xl font-bold tracking-tight mb-6"
        >
          <span className="bg-clip-text text-transparent bg-gradient-to-b from-white to-gray-400">
            Understand any
          </span>
          <br />
          <span className="bg-clip-text text-transparent bg-gradient-to-r from-purple-400 via-violet-400 to-indigo-400">
            codebase
          </span>
          <span className="bg-clip-text text-transparent bg-gradient-to-b from-white to-gray-400">
            {" "}in seconds
          </span>
        </motion.h1>

        {/* Subheading */}
        <motion.p
          custom={2}
          variants={fadeUpVariants}
          initial="hidden"
          animate="visible"
          className="max-w-xl mx-auto text-lg text-gray-400 mb-10 leading-relaxed"
        >
          Paste a GitHub URL. CodeGraph parses every function, class, and
          dependency with real AST analysis — then renders your architecture
          as an interactive knowledge graph you can explore and share.
        </motion.p>

        {/* URL Input + Buttons */}
        <motion.div
          custom={3}
          variants={fadeUpVariants}
          initial="hidden"
          animate="visible"
          className="w-full max-w-2xl mx-auto"
        >
          {/* Input row */}
          <div className="flex gap-2 items-stretch">
            <input
              type="text"
              value={repoUrl}
              onChange={e => { setRepoUrl(e.target.value); setUrlError(''); }}
              onKeyDown={e => e.key === 'Enter' && handleAnalyze()}
              placeholder="https://github.com/owner/repo"
              className="
                flex-1 h-12 px-4 rounded-xl
                bg-white/5 border border-white/10
                text-white placeholder:text-white/30
                font-mono text-sm
                focus:outline-none focus:border-purple-500/60
                transition-all duration-200
                backdrop-blur-sm
              "
            />
            <button
              onClick={handleAnalyze}
              className="
                h-12 px-6 rounded-xl font-semibold text-sm
                bg-purple-600 hover:bg-purple-500
                text-white flex items-center gap-2
                transition-all duration-200
                shadow-lg shadow-purple-900/40
              "
            >
              Analyze Repo
              <ArrowRight className="h-4 w-4" />
            </button>
          </div>

          {/* Error */}
          {urlError && (
            <p className="mt-2 text-sm text-red-400 font-mono text-left">
              {urlError}
            </p>
          )}

          {/* Example pills */}
          <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
            <span className="text-xs text-white/30 font-mono">Try:</span>
            {['psf/requests', 'pallets/flask', 'encode/starlette', 'tiangolo/fastapi'].map(ex => (
              <button
                key={ex}
                onClick={() => {
                  setRepoUrl(`https://github.com/${ex}`);
                  setUrlError('');
                }}
                className="
                  px-3 py-1 rounded-full text-xs font-mono
                  border border-white/10 text-white/40
                  hover:border-purple-500/50 hover:text-white/80
                  transition-all duration-150
                "
              >
                {ex}
              </button>
            ))}
          </div>
        </motion.div>
      </div>
    </div>
  );
}

export default Hero;
