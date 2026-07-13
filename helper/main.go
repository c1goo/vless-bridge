// VLESS Bridge helper — Native Messaging host для Chrome-расширения.
// Принимает команды start/stop/status, управляет процессом xray-core.
//
// Протокол Native Messaging: 4 байта длины (little-endian) + JSON.
package main

import (
	"bufio"
	"bytes"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"time"
)

type request struct {
	ID     int             `json:"id"`
	Cmd    string          `json:"cmd"`
	Link   string          `json:"link,omitempty"`   // vless:// ссылка
	Config json.RawMessage `json:"config,omitempty"` // готовый конфиг xray
	URL    string          `json:"url,omitempty"`    // адрес подписки для fetchSub
}

type response struct {
	ID    int    `json:"id"`
	OK    bool   `json:"ok"`
	Port  int    `json:"port,omitempty"`
	Error string `json:"error,omitempty"`
	State string `json:"state,omitempty"`
	Body  string `json:"body,omitempty"` // тело ответа подписки (fetchSub)
	MS    int    `json:"ms,omitempty"`   // задержка через туннель, мс (latency)
}

var (
	xrayCmd  *exec.Cmd
	xrayPort int
	xrayDone chan struct{} // закрывается, когда cmd.Wait() для xrayCmd завершился
)

func main() {
	for {
		req, err := readMessage(os.Stdin)
		if err != nil {
			if err == io.EOF {
				stopXray()
				return
			}
			continue
		}
		resp := handle(req)
		writeMessage(os.Stdout, resp)
	}
}

func handle(req request) response {
	switch req.Cmd {
	case "start":
		port, err := startXray(req.Link, req.Config)
		if err != nil {
			return response{ID: req.ID, OK: false, Error: err.Error()}
		}
		return response{ID: req.ID, OK: true, Port: port}
	case "stop":
		stopXray()
		return response{ID: req.ID, OK: true}
	case "status":
		state := "stopped"
		if xrayCmd != nil && xrayCmd.Process != nil {
			state = "running"
		}
		return response{ID: req.ID, OK: true, State: state, Port: xrayPort}
	case "fetchSub":
		body, err := fetchSub(req.URL)
		if err != nil {
			return response{ID: req.ID, OK: false, Error: err.Error()}
		}
		return response{ID: req.ID, OK: true, Body: body}
	case "latency":
		ms, err := measureLatency(req.Link, req.Config)
		if err != nil {
			return response{ID: req.ID, OK: false, Error: err.Error()}
		}
		return response{ID: req.ID, OK: true, MS: ms}
	default:
		return response{ID: req.ID, OK: false, Error: "unknown command: " + req.Cmd}
	}
}

// --- subscription fetch ---

// fetchSub скачивает подписку по URL обычным HTTP-клиентом. В отличие от
// браузера, антибот-прокси провайдера (DDoS-Guard/Cloudflare) пропускает такой
// запрос — helper для него неотличим от curl. Тело возвращается как есть,
// разбором формата занимается расширение.
func fetchSub(subURL string) (string, error) {
	if subURL == "" {
		return "", fmt.Errorf("пустой URL подписки")
	}
	client := &http.Client{Timeout: 15 * time.Second}
	resp, err := client.Get(subURL)
	if err != nil {
		// В URL зашит секретный токен подписки — не тащим его в текст ошибки,
		// оставляем только суть (таймаут / DNS / отказ соединения).
		var uerr *url.Error
		if errors.As(err, &uerr) {
			err = uerr.Err
		}
		return "", fmt.Errorf("не удалось скачать подписку: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return "", fmt.Errorf("сервер подписки ответил: %s", resp.Status)
	}
	data, err := io.ReadAll(io.LimitReader(resp.Body, 8<<20)) // до 8 МБ
	if err != nil {
		return "", fmt.Errorf("ошибка чтения ответа подписки: %v", err)
	}
	return string(data), nil
}

// --- latency (пинг через туннель) ---

// measureLatency поднимает xray на временном порту для выбранного сервера,
// делает GET через его SOCKS до лёгкого эндпоинта и возвращает задержку в мс.
// Работает независимо от активного подключения (свой порт, свой конфиг,
// глобальный xrayCmd не трогает).
func measureLatency(link string, raw json.RawMessage) (int, error) {
	var cfg *xrayConfig
	var err error
	if len(raw) > 0 {
		cfg, err = adoptConfig(raw)
	} else {
		cfg, err = buildConfig(link)
	}
	if err != nil {
		return 0, fmt.Errorf("конфиг: %w", err)
	}

	port, err := freePort()
	if err != nil {
		return 0, err
	}
	cfg.setInboundPort(port)

	dir, err := workDir()
	if err != nil {
		return 0, err
	}
	// Отдельное имя файла на порт — чтобы не затирать active-config.json
	// работающего подключения.
	cfgPath := filepath.Join(dir, fmt.Sprintf("latency-%d.json", port))
	data, _ := json.MarshalIndent(cfg.root, "", "  ")
	if err := os.WriteFile(cfgPath, data, 0600); err != nil {
		return 0, fmt.Errorf("запись конфига: %w", err)
	}
	defer os.Remove(cfgPath)

	xrayPath, err := findXray()
	if err != nil {
		return 0, err
	}

	var xrayLog bytes.Buffer
	cmd := exec.Command(xrayPath, "run", "-c", cfgPath)
	cmd.Stdout = &xrayLog
	cmd.Stderr = &xrayLog
	hideWindow(cmd)
	if err := cmd.Start(); err != nil {
		return 0, fmt.Errorf("запуск xray: %w", err)
	}
	done := make(chan struct{})
	go func() { _ = cmd.Wait(); close(done) }()
	defer func() {
		_ = cmd.Process.Kill()
		<-done
	}()

	// Ждём, пока SOCKS-порт поднимется (до 4 секунд), или xray упадёт.
	deadline := time.Now().Add(4 * time.Second)
	for {
		conn, derr := net.DialTimeout("tcp", fmt.Sprintf("127.0.0.1:%d", port), 200*time.Millisecond)
		if derr == nil {
			conn.Close()
			break
		}
		select {
		case <-done:
			return 0, fmt.Errorf("xray не запустился: %s", shortTail(&xrayLog))
		default:
		}
		if time.Now().After(deadline) {
			return 0, fmt.Errorf("xray не поднялся за отведённое время")
		}
		time.Sleep(100 * time.Millisecond)
	}

	return socks5Get(port, "cp.cloudflare.com", 80, "/generate_204", 6*time.Second)
}

// socks5Get открывает соединение к локальному SOCKS5 (без аутентификации),
// делает CONNECT к host:port и HTTP GET, возвращая время round-trip до первой
// строки ответа. Только стандартная библиотека — без x/net/proxy.
func socks5Get(socksPort int, host string, port int, path string, timeout time.Duration) (int, error) {
	conn, err := net.DialTimeout("tcp", fmt.Sprintf("127.0.0.1:%d", socksPort), 2*time.Second)
	if err != nil {
		return 0, fmt.Errorf("нет соединения с прокси: %v", err)
	}
	defer conn.Close()
	_ = conn.SetDeadline(time.Now().Add(timeout))

	// SOCKS5 greeting: VER=5, 1 метод, 0x00 (no auth)
	if _, err := conn.Write([]byte{0x05, 0x01, 0x00}); err != nil {
		return 0, err
	}
	sel := make([]byte, 2)
	if _, err := io.ReadFull(conn, sel); err != nil {
		return 0, err
	}
	if sel[0] != 0x05 || sel[1] != 0x00 {
		return 0, fmt.Errorf("socks5: метод аутентификации отклонён")
	}

	// Отсюда засекаем: CONNECT идёт через туннель до целевого хоста.
	start := time.Now()

	// CONNECT host:port, ATYP=domain (0x03)
	hb := []byte(host)
	req := append([]byte{0x05, 0x01, 0x00, 0x03, byte(len(hb))}, hb...)
	req = append(req, byte(port>>8), byte(port))
	if _, err := conn.Write(req); err != nil {
		return 0, err
	}
	head := make([]byte, 4)
	if _, err := io.ReadFull(conn, head); err != nil {
		return 0, err
	}
	if head[1] != 0x00 {
		return 0, fmt.Errorf("socks5: соединение отклонено (код %d)", head[1])
	}
	// Пропускаем BND.ADDR + BND.PORT в зависимости от типа адреса.
	switch head[3] {
	case 0x01: // IPv4
		_, err = io.ReadFull(conn, make([]byte, 4+2))
	case 0x04: // IPv6
		_, err = io.ReadFull(conn, make([]byte, 16+2))
	case 0x03: // domain
		l := make([]byte, 1)
		if _, err = io.ReadFull(conn, l); err == nil {
			_, err = io.ReadFull(conn, make([]byte, int(l[0])+2))
		}
	default:
		return 0, fmt.Errorf("socks5: неизвестный тип адреса")
	}
	if err != nil {
		return 0, err
	}

	httpReq := fmt.Sprintf("GET %s HTTP/1.1\r\nHost: %s\r\nUser-Agent: vless-bridge\r\nConnection: close\r\n\r\n", path, host)
	if _, err := conn.Write([]byte(httpReq)); err != nil {
		return 0, err
	}
	line, err := bufio.NewReader(conn).ReadString('\n')
	if err != nil {
		return 0, fmt.Errorf("нет ответа через туннель: %v", err)
	}
	elapsed := time.Since(start)

	// "HTTP/1.1 204 No Content"
	fields := strings.Fields(line)
	if len(fields) < 2 || !strings.HasPrefix(fields[0], "HTTP/") {
		return 0, fmt.Errorf("некорректный ответ эндпоинта")
	}
	if code, _ := strconv.Atoi(fields[1]); code >= 400 {
		return 0, fmt.Errorf("эндпоинт вернул %d", code)
	}
	return int(elapsed.Milliseconds()), nil
}

// shortTail — короткий хвост вывода xray для компактных ошибок (latency).
func shortTail(log *bytes.Buffer) string {
	s := strings.TrimSpace(log.String())
	if r := []rune(s); len(r) > 160 {
		s = "…" + string(r[len(r)-160:])
	}
	if s == "" {
		s = "нет вывода"
	}
	return s
}

// --- xray management ---

func startXray(link string, raw json.RawMessage) (int, error) {
	stopXray()

	var cfg *xrayConfig
	var err error
	if len(raw) > 0 {
		// Подписка отдала готовый конфиг xray — используем его как есть,
		// подменив только inbound на наш локальный SOCKS.
		cfg, err = adoptConfig(raw)
		if err != nil {
			return 0, fmt.Errorf("конфиг из подписки: %w", err)
		}
	} else {
		cfg, err = buildConfig(link)
		if err != nil {
			return 0, fmt.Errorf("разбор ссылки: %w", err)
		}
	}

	port, err := freePort()
	if err != nil {
		return 0, fmt.Errorf("не найден свободный порт: %w", err)
	}
	cfg.setInboundPort(port)

	dir, err := workDir()
	if err != nil {
		return 0, err
	}
	cfgPath := filepath.Join(dir, "active-config.json")
	data, _ := json.MarshalIndent(cfg.root, "", "  ")
	if err := os.WriteFile(cfgPath, data, 0600); err != nil {
		return 0, fmt.Errorf("запись конфига: %w", err)
	}

	xrayPath, err := findXray()
	if err != nil {
		return 0, err
	}

	var xrayLog bytes.Buffer
	cmd := exec.Command(xrayPath, "run", "-c", cfgPath)
	// Перехватываем вывод xray. stdout и stderr — в один буфер: при одинаковом
	// writer'е os/exec сериализует записи (гонки нет), а причина сбоя у xray
	// может уйти в любой из потоков. По этому буферу и покажем, на что он ругается.
	cmd.Stdout = &xrayLog
	cmd.Stderr = &xrayLog
	hideWindow(cmd)
	if err := cmd.Start(); err != nil {
		return 0, fmt.Errorf("запуск xray: %w", err)
	}

	// cmd.Wait() в фоне: реапит процесс, дописывает вывод в буфер и закрывает
	// канал. Он — единственный владелец Wait; stopXray ждёт этот канал.
	done := make(chan struct{})
	go func() { _ = cmd.Wait(); close(done) }()

	// Ждём, пока SOCKS-порт начнёт слушаться (до 5 секунд) — или xray упадёт.
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		conn, derr := net.DialTimeout("tcp", fmt.Sprintf("127.0.0.1:%d", port), 200*time.Millisecond)
		if derr == nil {
			conn.Close()
			xrayCmd = cmd
			xrayPort = port
			xrayDone = done
			return port, nil
		}
		// процесс мог сразу упасть (битый конфиг/ссылка) — не ждём весь таймаут
		select {
		case <-done:
			return 0, xrayStartError(&xrayLog)
		default:
		}
		time.Sleep(150 * time.Millisecond)
	}
	_ = cmd.Process.Kill()
	<-done // дождёмся, пока cmd.Wait() допишет буфер, прежде чем читать его
	return 0, xrayStartError(&xrayLog)
}

// xrayStartError формирует ошибку запуска, вкладывая последние ~500 символов
// вывода xray — обычно там и лежит настоящая причина (битый reality-ключ,
// недоступный сервер, ошибка конфига).
func xrayStartError(log *bytes.Buffer) error {
	out := strings.TrimSpace(log.String())
	if out == "" {
		return fmt.Errorf("xray не поднялся — проверьте ссылку (xray ничего не вывел)")
	}
	const max = 500
	if r := []rune(out); len(r) > max {
		out = "…" + string(r[len(r)-max:])
	}
	return fmt.Errorf("xray не поднялся:\n%s", out)
}

func stopXray() {
	if xrayCmd != nil && xrayCmd.Process != nil {
		_ = xrayCmd.Process.Kill()
		if xrayDone != nil {
			<-xrayDone // cmd.Wait() выполняется в фоне — дождёмся реапа, не зовём Wait повторно
		}
	}
	xrayCmd = nil
	xrayPort = 0
	xrayDone = nil
}

func findXray() (string, error) {
	exe, err := os.Executable()
	if err != nil {
		return "", err
	}
	name := "xray"
	if runtime.GOOS == "windows" {
		name = "xray.exe"
	}
	p := filepath.Join(filepath.Dir(exe), name)
	if _, err := os.Stat(p); err != nil {
		return "", fmt.Errorf("не найден %s рядом с helper'ом (%s)", name, p)
	}
	return p, nil
}

func workDir() (string, error) {
	exe, err := os.Executable()
	if err != nil {
		return "", err
	}
	return filepath.Dir(exe), nil
}

func freePort() (int, error) {
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return 0, err
	}
	defer l.Close()
	return l.Addr().(*net.TCPAddr).Port, nil
}

// --- native messaging framing ---

func readMessage(r io.Reader) (request, error) {
	var length uint32
	if err := binary.Read(r, binary.LittleEndian, &length); err != nil {
		return request{}, err
	}
	if length == 0 || length > 1<<20 {
		return request{}, fmt.Errorf("bad length")
	}
	buf := make([]byte, length)
	if _, err := io.ReadFull(r, buf); err != nil {
		return request{}, err
	}
	var req request
	if err := json.Unmarshal(buf, &req); err != nil {
		return request{}, err
	}
	return req, nil
}

func writeMessage(w io.Writer, v any) {
	data, _ := json.Marshal(v)
	_ = binary.Write(w, binary.LittleEndian, uint32(len(data)))
	_, _ = w.Write(data)
}
