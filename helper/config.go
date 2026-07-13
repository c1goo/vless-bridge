package main

import (
	"encoding/json"
	"fmt"
	"net/url"
	"strconv"
	"strings"
)

// xrayConfig — обёртка над JSON-конфигом xray-core.
type xrayConfig struct {
	root map[string]any
}

func (c *xrayConfig) setInboundPort(port int) {
	inbounds := c.root["inbounds"].([]any)
	inbounds[0].(map[string]any)["port"] = port
}

// localSocksInbound — единственный inbound, который мы разрешаем:
// SOCKS5 на localhost. Порт подставляется в setInboundPort.
func localSocksInbound() map[string]any {
	return map[string]any{
		"listen":   "127.0.0.1",
		"port":     0,
		"protocol": "socks",
		"settings": map[string]any{"auth": "noauth", "udp": true},
		"sniffing": map[string]any{
			"enabled":      true,
			"destOverride": []any{"http", "tls"},
		},
	}
}

// adoptConfig принимает готовый конфиг xray из подписки и адаптирует его:
// outbounds, routing, dns остаются провайдерские, а inbounds заменяются
// на один локальный SOCKS. Это важно по двум причинам:
//   - в конфигах из подписок порт inbound'а зашит намертво (обычно 10808)
//     и может быть занят другим клиентом;
//   - конфиг может открывать лишние inbound'ы (http-прокси, api), которые
//     нам не нужны и лишний раз слушают порты.
func adoptConfig(raw []byte) (*xrayConfig, error) {
	var root map[string]any
	if err := json.Unmarshal(raw, &root); err != nil {
		return nil, fmt.Errorf("не удалось разобрать JSON: %w", err)
	}

	obs, ok := root["outbounds"].([]any)
	if !ok || len(obs) == 0 {
		return nil, fmt.Errorf("в конфиге нет outbounds")
	}

	root["inbounds"] = []any{localSocksInbound()}

	// Блок stats/api/policy ссылается на inbound с тегом "api", который мы
	// только что удалили — иначе xray не стартует.
	delete(root, "api")
	delete(root, "stats")
	delete(root, "policy")
	stripAPIRoutingRules(root)

	return &xrayConfig{root: root}, nil
}

// stripAPIRoutingRules убирает routing-правила, ведущие на несуществующий
// теперь inbound/outbound "api".
func stripAPIRoutingRules(root map[string]any) {
	routing, ok := root["routing"].(map[string]any)
	if !ok {
		return
	}
	rules, ok := routing["rules"].([]any)
	if !ok {
		return
	}
	kept := make([]any, 0, len(rules))
	for _, r := range rules {
		rule, ok := r.(map[string]any)
		if !ok {
			continue
		}
		if tag, _ := rule["outboundTag"].(string); tag == "api" {
			continue
		}
		if tags, ok := rule["inboundTag"].([]any); ok {
			isAPI := false
			for _, t := range tags {
				if s, _ := t.(string); s == "api" {
					isAPI = true
				}
			}
			if isAPI {
				continue
			}
		}
		kept = append(kept, rule)
	}
	routing["rules"] = kept
}

// buildConfig превращает vless:// ссылку в конфиг xray:
// локальный SOCKS5-инбаунд + VLESS-аутбаунд.
func buildConfig(link string) (*xrayConfig, error) {
	link = strings.TrimSpace(link)
	if !strings.HasPrefix(strings.ToLower(link), "vless://") {
		return nil, fmt.Errorf("ожидается vless:// ссылка")
	}

	u, err := url.Parse("http://" + link[len("vless://"):])
	if err != nil {
		return nil, err
	}

	uuid := u.User.Username()
	host := u.Hostname()
	portStr := u.Port()
	if portStr == "" {
		portStr = "443"
	}
	port, err := strconv.Atoi(portStr)
	if err != nil || uuid == "" || host == "" {
		return nil, fmt.Errorf("в ссылке нет uuid/адреса/порта")
	}

	q := u.Query()
	network := def(q.Get("type"), "tcp")
	security := def(q.Get("security"), "none")

	user := map[string]any{
		"id":         uuid,
		"encryption": def(q.Get("encryption"), "none"),
	}
	if flow := q.Get("flow"); flow != "" {
		user["flow"] = flow
	}

	stream := map[string]any{
		"network":  network,
		"security": security,
	}

	switch security {
	case "tls":
		tls := map[string]any{"allowInsecure": false}
		if sni := q.Get("sni"); sni != "" {
			tls["serverName"] = sni
		}
		if fp := q.Get("fp"); fp != "" {
			tls["fingerprint"] = fp
		}
		if alpn := q.Get("alpn"); alpn != "" {
			tls["alpn"] = strings.Split(alpn, ",")
		}
		stream["tlsSettings"] = tls
	case "reality":
		reality := map[string]any{
			"publicKey":   q.Get("pbk"),
			"shortId":     q.Get("sid"),
			"fingerprint": def(q.Get("fp"), "chrome"),
		}
		if sni := q.Get("sni"); sni != "" {
			reality["serverName"] = sni
		}
		if spx := q.Get("spx"); spx != "" {
			reality["spiderX"] = spx
		}
		stream["realitySettings"] = reality
	}

	switch network {
	case "ws":
		ws := map[string]any{"path": def(q.Get("path"), "/")}
		if h := q.Get("host"); h != "" {
			ws["headers"] = map[string]any{"Host": h}
		}
		stream["wsSettings"] = ws
	case "grpc":
		stream["grpcSettings"] = map[string]any{
			"serviceName": q.Get("serviceName"),
		}
	case "tcp":
		if q.Get("headerType") == "http" {
			stream["tcpSettings"] = map[string]any{
				"header": map[string]any{"type": "http"},
			}
		}
	}

	root := map[string]any{
		"log": map[string]any{"loglevel": "warning"},
		"inbounds": []any{
			map[string]any{
				"listen":   "127.0.0.1",
				"port":     0, // заполняется в setInboundPort
				"protocol": "socks",
				"settings": map[string]any{"udp": true},
			},
		},
		"outbounds": []any{
			map[string]any{
				"protocol": "vless",
				"settings": map[string]any{
					"vnext": []any{
						map[string]any{
							"address": host,
							"port":    port,
							"users":   []any{user},
						},
					},
				},
				"streamSettings": stream,
			},
		},
	}

	return &xrayConfig{root: root}, nil
}

func def(v, fallback string) string {
	if v == "" {
		return fallback
	}
	return v
}
