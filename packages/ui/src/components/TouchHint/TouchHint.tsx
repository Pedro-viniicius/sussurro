import { useEffect, useState } from 'react';
import { Animated, Easing, StyleSheet, View } from 'react-native';
import Svg, { Path } from 'react-native-svg';

import { useReducedMotion } from '../../preferences';
import { theme } from '../../theme';
import { Logo } from '../Logo/Logo';

/**
 * `demo`: o Pronto, com a demonstração (2 ciclos) que para na pose "afastados", com as setas;
 * `approaching`: a pose "quase" (vão de 8, selo a 40%); `touching`: "encostados" (vão 0, selo com
 * sombra e um "pop" ao entrar).
 */
export type TouchHintPose = 'demo' | 'approaching' | 'touching';

export interface TouchHintProps {
  pose: TouchHintPose;
  /** Telas com menos de 700 pt de altura (iPhone SE): 200 × 180 em vez de 240 × 216. */
  compact?: boolean;
  testID?: string;
}

/** Medidas da ilustração (ux.md §11.7), em pt, no tamanho normal. */
const BOX = { width: 240, height: 216 } as const;
const PHONE = { width: 52, height: 92 } as const;
/** Quanto cada celular anda até a pose: o vão de 32 vira 8 ("quase") ou 0 ("encostados"). */
const SHIFT = { rest: 0, approaching: 12, touching: 16 } as const;
const SEAL = 44;
const LOGO = 28;
const CHEVRON = 16;
const COMPACT_SCALE = 180 / BOX.height;
/** Demonstração: 2 ciclos de `motion.touchCycle` (4,8 s, menos de 5 s: WCAG 2.2.2). */
const DEMO_CYCLES = 2;
export const TOUCH_HINT_DEMO_MS = theme.motion.touchCycle * DEMO_CYCLES;
/** Com "Reduzir movimento", as poses trocam só com um fade de até 150 ms. */
const REDUCED_FADE_MS = 150;

const EASING = Easing.bezier(...theme.motion.easing);

export function touchHintSize(compact = false): { width: number; height: number } {
  const scale = compact ? COMPACT_SCALE : 1;
  return { width: BOX.width * scale, height: BOX.height * scale };
}

/** Retângulo de cantos arredondados como caminho SVG (`x`, `y`, largura, altura e raio). */
function roundedRect(x: number, y: number, width: number, height: number, r: number) {
  const right = x + width;
  const bottom = y + height;
  return [
    `M${x + r} ${y}`,
    `H${right - r}`,
    `A${r} ${r} 0 0 1 ${right} ${y + r}`,
    `V${bottom - r}`,
    `A${r} ${r} 0 0 1 ${right - r} ${bottom}`,
    `H${x + r}`,
    `A${r} ${r} 0 0 1 ${x} ${bottom - r}`,
    `V${y + r}`,
    `A${r} ${r} 0 0 1 ${x + r} ${y}`,
    'Z',
  ].join(' ');
}

/** Um celular (52 × 92, raio 12, traço 2): contorno preto, tela `blueLight` e o alto-falante. */
function Phone({ scale }: { scale: number }) {
  return (
    <Svg
      width={PHONE.width * scale}
      height={PHONE.height * scale}
      viewBox={`0 0 ${PHONE.width} ${PHONE.height}`}
    >
      <Path
        d={roundedRect(1, 1, PHONE.width - 2, PHONE.height - 2, 11)}
        fill={theme.colors.white}
        stroke={theme.colors.black}
        strokeWidth={2}
      />
      <Path
        d={roundedRect(4, 4, PHONE.width - 8, PHONE.height - 8, 8)}
        fill={theme.colors.blueLight}
      />
      <Path d={roundedRect((PHONE.width - 14) / 2, 6, 14, 3, 1.5)} fill={theme.colors.black} />
    </Svg>
  );
}

function Chevron({ direction, scale }: { direction: 'down' | 'up'; scale: number }) {
  return (
    <Svg width={CHEVRON * scale} height={CHEVRON * scale} viewBox="0 0 16 16">
      <Path
        d={direction === 'down' ? 'M4 6 L8 10 L12 6' : 'M4 10 L8 6 L12 10'}
        stroke={theme.colors.grey}
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />
    </Svg>
  );
}

interface Values {
  shift: Animated.Value;
  /** O seu celular anda no sentido contrário ao da outra pessoa. */
  negativeShift: Animated.AnimatedMultiplication;
  seal: Animated.Value;
  sealScale: Animated.Value;
  arrows: Animated.Value;
}

function timing(value: Animated.Value, toValue: number, duration: number) {
  return Animated.timing(value, { toValue, duration, easing: EASING, useNativeDriver: true });
}

/**
 * Um ciclo da demonstração (ux.md §11.7), em `motion.touchCycle` (2400 ms): os celulares andam um
 * para o outro (0–800), o selo aparece (800–1100), pausa encostados (1100–1700), o selo some e os
 * celulares voltam (1700–2100) e pausa afastados (2100–2400).
 */
function demoCycle(values: Values, scale: number) {
  const cycle = theme.motion.touchCycle;
  const approach = cycle / 3;
  const appear = cycle / 8;
  const hold = cycle / 4;
  const leave = cycle / 6;
  const rest = cycle / 8;
  return Animated.sequence([
    Animated.parallel([timing(values.sealScale, 0.6, 0), timing(values.seal, 0, 0)]),
    timing(values.shift, SHIFT.touching * scale, approach),
    Animated.parallel([timing(values.seal, 1, appear), timing(values.sealScale, 1, appear)]),
    Animated.delay(hold),
    Animated.parallel([timing(values.seal, 0, leave), timing(values.shift, 0, leave)]),
    Animated.delay(rest),
  ]);
}

/** O alvo de cada pose: deslocamento, opacidade do selo e das setas. */
function target(pose: TouchHintPose, scale: number) {
  switch (pose) {
    case 'demo':
      return { shift: SHIFT.rest * scale, seal: 0, arrows: 1 };
    case 'approaching':
      return { shift: SHIFT.approaching * scale, seal: 0.4, arrows: 0 };
    case 'touching':
      return { shift: SHIFT.touching * scale, seal: 1, arrows: 0 };
  }
}

/**
 * A ilustração do encostar (ux.md §11.7; substitui o radar): dois celulares, o da outra pessoa em
 * cima (de cabeça para baixo) e o seu embaixo, que se aproximam até formar o S do Sussurro no
 * ponto de contato. Decorativa: some do leitor de tela (o significado está no texto ao lado).
 *
 * A demonstração roda 2 ciclos e para; para rodar de novo, o pai monta de novo (`key`). Com
 * "Reduzir movimento": sem deslocamento nem escala, as poses trocam com fade de até 150 ms e o
 * Pronto já fica parado na pose "afastados" com as setas. Nada pisca (WCAG 2.3.1).
 */
export function TouchHint({ pose, compact = false, testID = 'touch-hint' }: TouchHintProps) {
  const reduceMotion = useReducedMotion();
  const scale = compact ? COMPACT_SCALE : 1;
  const [values] = useState<Values>(() => {
    const initial = target(pose, scale);
    const shift = new Animated.Value(initial.shift);
    return {
      shift,
      negativeShift: Animated.multiply(shift, -1),
      seal: new Animated.Value(initial.seal),
      sealScale: new Animated.Value(1),
      arrows: new Animated.Value(initial.arrows),
    };
  });
  const [demoFinished, setDemoFinished] = useState(false);
  const demoRunning = pose === 'demo' && !reduceMotion && !demoFinished;

  useEffect(() => {
    if (demoRunning) {
      values.arrows.setValue(0);
      const cycles = Array.from({ length: DEMO_CYCLES }, () => demoCycle(values, scale));
      const demo = Animated.sequence(cycles);
      // Terminou ou foi interrompida (outra pose): não volta a rodar sem montar de novo.
      demo.start(() => {
        setDemoFinished(true);
      });
      return () => {
        demo.stop();
      };
    }
    const next = target(pose, scale);
    if (reduceMotion) {
      values.shift.setValue(next.shift);
      values.sealScale.setValue(1);
      const fade = Animated.parallel([
        timing(values.seal, next.seal, REDUCED_FADE_MS),
        timing(values.arrows, next.arrows, REDUCED_FADE_MS),
      ]);
      fade.start();
      return () => {
        fade.stop();
      };
    }
    const move = Animated.parallel([
      timing(values.shift, next.shift, theme.motion.base),
      timing(values.seal, next.seal, theme.motion.base),
      timing(values.arrows, next.arrows, theme.motion.base),
      // No Confirmando, o selo dá um "pop" (1 → 1,1 → 1) uma vez.
      pose === 'touching'
        ? Animated.sequence([
            timing(values.sealScale, 1.1, theme.motion.heart / 2),
            timing(values.sealScale, 1, theme.motion.heart / 2),
          ])
        : timing(values.sealScale, 1, theme.motion.base),
    ]);
    move.start();
    return () => {
      move.stop();
    };
  }, [demoRunning, pose, reduceMotion, scale, values]);

  const size = touchHintSize(compact);
  const phone = { width: PHONE.width * scale, height: PHONE.height * scale };
  const left = (size.width - phone.width) / 2;
  const middle = size.height / 2;
  const seal = SEAL * scale;
  const chevron = CHEVRON * scale;

  let state: string;
  if (reduceMotion) state = 'estatico';
  else if (demoRunning) state = 'animado';
  else state = pose === 'demo' ? 'repouso' : pose;

  return (
    <View
      testID={testID}
      style={[styles.container, size]}
      pointerEvents="none"
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      <View testID={`${testID}-${state}`} style={StyleSheet.absoluteFill} />
      <Animated.View
        testID={`${testID}-outro`}
        style={[
          styles.absolute,
          { left, top: 0 },
          { transform: [{ translateY: values.shift }, { rotate: '180deg' }] },
        ]}
      >
        <Phone scale={scale} />
      </Animated.View>
      <Animated.View
        testID={`${testID}-seu`}
        style={[
          styles.absolute,
          { left, top: size.height - phone.height },
          { transform: [{ translateY: values.negativeShift }] },
        ]}
      >
        <Phone scale={scale} />
      </Animated.View>
      <Animated.View
        testID={`${testID}-setas`}
        style={[
          styles.absolute,
          styles.arrows,
          { left: (size.width - chevron) / 2, top: middle - chevron, opacity: values.arrows },
        ]}
      >
        <Chevron direction="down" scale={scale} />
        <Chevron direction="up" scale={scale} />
      </Animated.View>
      <Animated.View
        testID={`${testID}-selo`}
        style={[
          styles.absolute,
          styles.seal,
          {
            width: seal,
            height: seal,
            borderRadius: seal / 2,
            left: (size.width - seal) / 2,
            top: middle - seal / 2,
            opacity: values.seal,
            transform: [{ scale: values.sealScale }],
          },
          pose === 'approaching' ? null : styles.sealShadow,
        ]}
      >
        <Logo variant="mark" size={Math.max(16, LOGO * scale)} testID={`${testID}-logo`} />
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { alignSelf: 'center' },
  absolute: { position: 'absolute' },
  arrows: { alignItems: 'center' },
  seal: {
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: theme.colors.white,
  },
  sealShadow: { boxShadow: theme.shadow.sm },
});
