#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."
root="$PWD"
version=8.1.2
archive="ffmpeg-$version.tar.xz"
checksum=464beb5e7bf0c311e68b45ae2f04e9cc2af88851abb4082231742a74d97b524c
source_url="https://ffmpeg.org/releases/$archive"
cache="$root/.build/ffmpeg-cache"
output="$root/.build/ffmpeg"
binary=ffmpeg

case "$(uname -s)" in
  Darwin)
    platform=darwin
    tls=securetransport
    export MACOSX_DEPLOYMENT_TARGET=13.0
    ;;
  Linux) platform=linux; tls=gnutls ;;
  MSYS_NT-*|MINGW*_NT-*)
    if [[ "${MSYSTEM:-}" != UCRT64 ]]; then
      echo 'No Windows, execute este script no terminal MSYS2 UCRT64.' >&2
      exit 1
    fi
    platform=win32
    tls=schannel
    binary=ffmpeg.exe
    ;;
  *) echo 'Sistema de compilação não suportado.' >&2; exit 1 ;;
esac

case "$(uname -m)" in
  x86_64) arch=x64 ;;
  arm64|aarch64) arch=arm64 ;;
  *) echo 'Arquitetura de compilação não suportada.' >&2; exit 1 ;;
esac

sha256() {
  if command -v sha256sum >/dev/null; then
    sha256sum "$1"
  else
    shasum -a 256 "$1"
  fi | cut -d ' ' -f 1
}

target="$platform-$arch"
stamp="$target $(sha256 scripts/build-ffmpeg.sh)"
if [[ -x "$output/$binary" && -f "$output/$archive" && -f "$output/build-target.txt" ]] &&
   [[ "$(cat "$output/build-target.txt")" == "$stamp" ]]; then
  echo "FFmpeg $version já compilado para $target."
  exit 0
fi

mkdir -p "$cache"
work="$(mktemp -d /tmp/onvif-ffmpeg-work.XXXXXX)"
stage_dir=
trap 'rm -rf "$work" ${stage_dir:+"$stage_dir"}' EXIT
stage_dir="$(mktemp -d "$root/.build/ffmpeg-stage.XXXXXX")"
if [[ ! -f "$cache/$archive" || "$(sha256 "$cache/$archive")" != "$checksum" ]]; then
  curl --fail --location --silent --show-error --retry 2 "$source_url" -o "$work/$archive"
  if [[ "$(sha256 "$work/$archive")" != "$checksum" ]]; then
    echo 'O código-fonte do FFmpeg falhou na verificação SHA-256.' >&2
    exit 1
  fi
  mv "$work/$archive" "$cache/$archive"
fi

tar -xf "$cache/$archive" -C "$work"
mkdir "$work/obj" "$stage_dir/package"
source_dir="$work/ffmpeg-$version"
stage="$stage_dir/package"
flags=(
  --disable-autodetect --disable-everything --disable-doc --disable-debug
  --disable-gpl --disable-nonfree --disable-ffplay --disable-ffprobe
  --disable-shared --enable-static --enable-network
  --enable-decoder=h264,hevc,mjpeg,mpeg4,av1,vp8,vp9,wrapped_avframe
  --enable-parser=h264,hevc,mjpeg,mpeg4video,av1,vp8,vp9
  --enable-demuxer=rtsp --enable-protocol=file,pipe,tcp,udp,rtp,tls
  --enable-encoder=mjpeg --enable-muxer=image2pipe
  --enable-indev=lavfi --enable-filter=fps,scale,format,null,testsrc
  "--enable-$tls"
)
if [[ "$arch" == x64 ]] && ! command -v nasm >/dev/null; then
  flags+=(--disable-x86asm)
fi
if [[ "$platform" == win32 ]]; then
  flags+=(--extra-ldflags=-static)
fi

jobs="$(getconf _NPROCESSORS_ONLN 2>/dev/null || echo 4)"
(
  cd "$work/obj"
  "$source_dir/configure" "${flags[@]}"
  make -j "$jobs" "$binary"
  cp -p "$binary" "$stage/$binary"
)

# Check the features used by the app before staging the binary.
"$stage/$binary" -hide_banner -demuxers | grep -E 'rtsp[[:space:]]' >/dev/null
"$stage/$binary" -hide_banner -protocols | grep -Fx '  tls' >/dev/null
"$stage/$binary" -hide_banner -loglevel error -f lavfi -i 'testsrc=size=64x48:rate=25' \
  -vf "fps=8,scale=w='min(1280,iw)':h=-2" -threads 2 -q:v 5 -frames:v 1 \
  -f image2pipe -c:v mjpeg "$work/test.jpg"
test -s "$work/test.jpg"

cp "$source_dir/COPYING.LGPLv2.1" "$source_dir/CREDITS" "$cache/$archive" "$stage/"
{
  printf 'FFmpeg %s — LGPL 2.1 ou posterior\n' "$version"
  printf 'Código-fonte original: %s\nSHA-256: %s\n' "$source_url" "$checksum"
  printf 'Comando de configuração: ./configure'
  printf ' %s' "${flags[@]}"
  printf '\n'
} > "$stage/NOTICE.txt"
printf '%s\n' "$stamp" > "$stage/build-target.txt"

if [[ -e "$output" ]]; then mv "$output" "$stage_dir/previous"; fi
mv "$stage" "$output"
echo "FFmpeg $version preparado para $target."
