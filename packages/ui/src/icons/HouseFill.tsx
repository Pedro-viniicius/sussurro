import Svg, { Path, type SvgProps } from 'react-native-svg';

export interface CustomIconProps extends Omit<SvgProps, 'color'> {
  size?: number;
  color?: string;
  strokeWidth?: number;
}

/**
 * Casa preenchida com a porta vazada: estado ativo da aba Início (ux.md §6.11). O `fill` do
 * ícone `house` do Lucide cobre a porta, por isso este SVG próprio, com o mesmo contorno do
 * Lucide e a porta recortada por `fillRule="evenodd"`.
 */
export function HouseFill({
  size = 24,
  color = '#000000',
  strokeWidth = 2,
  ...rest
}: CustomIconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" {...rest}>
      <Path
        d="M3 10a2 2 0 0 1 .709-1.528l7-6a2 2 0 0 1 2.582 0l7 6A2 2 0 0 1 21 10v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z M10 21v-6.5a.5.5 0 0 1 .5-.5h3a.5.5 0 0 1 .5.5V21z"
        fill={color}
        fillRule="evenodd"
        stroke={color}
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </Svg>
  );
}
