# ONVIF Local

Aplicativo desktop em Electron para cadastrar e operar câmeras ONVIF na rede local. A interface permite buscar dispositivos, selecionar perfis de mídia, visualizar vídeo RTSP, salvar capturas e operar PTZ quando o perfil oferece esse serviço.

## Executar

Requer Node.js 22.12 ou mais recente e npm.

```sh
npm ci
npm start
```

O npm instala o FFmpeg opcionalmente. Se o binário não estiver disponível para a sua plataforma, instale o FFmpeg no `PATH` ou informe o caminho com `ONVIF_FFMPEG`. No macOS, permita acesso à Rede Local para o aplicativo ou terminal se o sistema solicitar.

## Gerar executáveis e instaladores

| Sistema | Arquitetura | Arquivos |
| --- | --- | --- |
| Windows | x64 | Instalador NSIS `.exe` |
| macOS 13 ou posterior | Apple Silicon ou Intel | Imagem `.dmg` com o aplicativo `.app` |
| Linux | x64 | `.AppImage` portátil e pacote `.deb` para Debian/Ubuntu |

No GitHub, execute **Actions → Instaladores → Run workflow**. O workflow também roda ao enviar uma tag `v*`. Cada sistema gera seu próprio artefato, disponível na página da execução.

Para gerar localmente, use o sistema e a arquitetura de destino com Node.js 22.12 ou posterior. Instale as ferramentas de compilação do sistema.

- **macOS** — instale as ferramentas de linha de comando do Xcode com `xcode-select --install`.
- **Linux (Debian/Ubuntu)** — instale `build-essential libgnutls28-dev nasm pkg-config fakeroot curl xz-utils`.
- **Windows** — no terminal [MSYS2 UCRT64](https://www.msys2.org/), instale `curl make tar xz mingw-w64-ucrt-x86_64-gcc mingw-w64-ucrt-x86_64-nasm` com `pacman -S --needed`.

No macOS e Linux, rode os três comandos no terminal. No Windows, rode a linha com `bash` no MSYS2 UCRT64 e as linhas com `npm` no PowerShell, na mesma pasta do projeto.

```sh
npm ci --omit=optional
bash scripts/build-ffmpeg.sh
npm run dist
```

Os instaladores ficam em `dist/`. Use `npm run pack` para gerar apenas a pasta com o aplicativo executável. Os pacotes incluem o ícone, o FFmpeg para vídeo RTSP, a licença LGPL e o código-fonte correspondente. O `.dmg` tem assinatura ad hoc e o `.exe` é gerado sem certificado de distribuição. O macOS e o Windows podem exibir um aviso de segurança na abertura.

Para instalar no macOS, abra o `.dmg` e arraste o aplicativo para **Aplicativos**. No Windows, execute o arquivo `-setup.exe`. No Linux, instale o `.deb` com `sudo apt install ./arquivo.deb` ou marque o `.AppImage` como executável e abra-o diretamente.

## Conectar uma câmera

1. Use **Buscar na rede** para localizar câmeras por WS-Discovery ou **Adicionar câmera** para preencher o endereço manualmente. É possível informar o IP, `IP:porta` ou a URL completa do serviço ONVIF.
2. Informe a conta ONVIF criada na própria câmera e selecione **Salvar e conectar**. O cadastro fica no computador. Por padrão, a senha só fica em memória até encerrar o aplicativo. A opção **Salvar senha no cofre do sistema** usa o armazenamento criptografado do Electron.
3. Selecione o perfil de vídeo. Use o painel PTZ para mover a câmera e acessar as posições cadastradas nela. **Salvar captura** usa a imagem ONVIF quando disponível e usa um quadro RTSP quando a câmera não oferece captura direta.

## Câmera de teste

A Tapo C510W anuncia o serviço `http://192.168.1.20:2020/onvif/device_service`. O diagnóstico solicita a senha no terminal sem exibi-la. Com `--video`, também decodifica um quadro do primeiro perfil H.264.

```sh
npm run test:camera
npm run test:camera -- 192.168.1.20 user --video
npm run check
```

O cliente implementa WS-Discovery, SOAP, WS-Security UsernameToken, autenticação HTTP Digest e Basic quando solicitada, serviços Device, Media e Media2 e operações PTZ de movimento, parada, consulta e seleção de posições. O FFmpeg decodifica o vídeo RTSP no processo principal, e a interface exibe uma prévia sem áudio. A implementação usa as [especificações oficiais do ONVIF](https://www.onvif.org/profiles/specifications/).
