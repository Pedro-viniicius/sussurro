import { screen, userEvent } from '@testing-library/react-native';
import { useState } from 'react';

import { RadioOptionList } from './RadioOptionList';
import { renderUi } from '../../test-utils/render';

const OPTIONS = [
  { key: 'personal', title: 'Pessoal', description: 'Conecta-se ao vivo e segue criadores.' },
  { key: 'creator', title: 'Criador', description: 'Só publica. Não segue nem se conecta.' },
] as const;

function Controlled({ onChange }: { onChange?: (key: string) => void }) {
  const [value, setValue] = useState<'personal' | 'creator'>('personal');
  return (
    <RadioOptionList
      legend="Tipo de conta"
      options={OPTIONS}
      value={value}
      onChange={(key) => {
        setValue(key);
        onChange?.(key);
      }}
      {...(value === 'creator' ? { helper: 'Não dá para trocar o tipo de conta depois.' } : {})}
    />
  );
}

describe('RadioOptionList', () => {
  it('grupo com legenda; cada opção é um radio e a marcada tem checked', async () => {
    await renderUi(<Controlled />);
    expect(screen.getByText('Tipo de conta')).toBeOnTheScreen();
    expect(screen.getByRole('radio', { name: 'Pessoal' })).toBeChecked();
    expect(screen.getByRole('radio', { name: 'Criador' })).not.toBeChecked();
    expect(screen.getByText('Só publica. Não segue nem se conecta.')).toBeOnTheScreen();
  });

  it('tocar numa opção chama onChange e mostra o helper', async () => {
    const onChange = jest.fn();
    await renderUi(<Controlled onChange={onChange} />);
    await userEvent.press(screen.getByRole('radio', { name: 'Criador' }));
    expect(onChange).toHaveBeenCalledWith('creator');
    expect(screen.getByRole('radio', { name: 'Criador' })).toBeChecked();
    expect(screen.getByText('Não dá para trocar o tipo de conta depois.')).toBeOnTheScreen();
  });

  it('desabilitada não muda a seleção', async () => {
    const onChange = jest.fn();
    await renderUi(
      <RadioOptionList
        legend="Tipo de conta"
        options={OPTIONS}
        value="personal"
        onChange={onChange}
        disabled
      />,
    );
    await userEvent.press(screen.getByRole('radio', { name: 'Criador' }));
    expect(onChange).not.toHaveBeenCalled();
  });
});
