import { screen, userEvent } from '@testing-library/react-native';
import { useState } from 'react';

import { SEARCH_PLACEHOLDER, SearchBar } from './SearchBar';
import { renderUi } from '../../test-utils/render';

function Controlled({ loading = false }: { loading?: boolean }) {
  const [value, setValue] = useState('');
  return <SearchBar value={value} onChangeText={setValue} loading={loading} />;
}

describe('SearchBar (p15, ux.md §6.14)', () => {
  it('campo "Pesquisar @criador" sem correção nem maiúsculas; "Limpar busca" aparece com texto', async () => {
    await renderUi(<Controlled />);
    const input = screen.getByLabelText(SEARCH_PLACEHOLDER);
    expect(input.props.placeholder).toBe('Pesquisar @criador');
    expect(input.props.autoCapitalize).toBe('none');
    expect(input.props.autoCorrect).toBe(false);
    expect(screen.queryByRole('button', { name: 'Limpar busca' })).not.toBeOnTheScreen();

    await userEvent.type(input, '@estu');
    expect(input).toHaveDisplayValue('@estu');
    await userEvent.press(screen.getByRole('button', { name: 'Limpar busca' }));
    expect(input).toHaveDisplayValue('');
  });

  it('carregando: spinner no fim da barra no lugar do "limpar"', async () => {
    await renderUi(<SearchBar value="estudio" onChangeText={jest.fn()} loading />);
    expect(screen.getByLabelText('Buscando')).toBeOnTheScreen();
    expect(screen.queryByRole('button', { name: 'Limpar busca' })).not.toBeOnTheScreen();
  });
});
