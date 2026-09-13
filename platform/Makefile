.DEFAULT_GOAL := help

BUN ?= bun
HELM ?= helm
PYTHON ?= python3
RELEASE ?= xsphere
NAMESPACE ?= sandbox
VALUES ?= deploy/values-dev.yaml
API_IMAGE ?= sandbox-api:xsphere-dev
ROUTER_IMAGE ?= sandbox-router:xsphere-dev
CONTROLLER_IMAGE ?= agent-sandbox-controller:xsphere-dev
CONTROLLER_TAG ?= v0.5.4
CONTROLLER_NAMESPACE ?= agent-sandbox-system
ARGS ?= --help

.PHONY: help install lint typecheck test build check render image dev runtime runtime-check controller-build router-build controller-image router-image images controller-render smoke-images

help:
	@echo 'xsphere: install | check | build | render | image | dev'
	@echo 'Runtime: runtime ARGS="--help" | runtime-check'
	@echo 'Shared components: controller-build | router-build | images | controller-render'
	@echo 'check/render are offline. Runtime node changes require explicit acknowledgement.'
	@echo 'Override VALUES with a local file for your environment.'

install:
	cd sandbox-api && $(BUN) install --frozen-lockfile

lint:
	cd sandbox-api && $(BUN) run lint
	KUBECONFIG=/dev/null $(HELM) lint deploy/chart --strict -f $(VALUES)

typecheck:
	cd sandbox-api && $(BUN) run typecheck

test:
	cd sandbox-api && NODE_ENV=production LOG_LEVEL=silent $(BUN) test

build:
	cd sandbox-api && $(BUN) run build

check: lint typecheck test build runtime-check

render:
	@KUBECONFIG=/dev/null $(HELM) template $(RELEASE) deploy/chart --namespace $(NAMESPACE) -f $(VALUES)

image:
	docker build -t $(API_IMAGE) sandbox-api

dev:
	cd sandbox-api && $(BUN) run dev

runtime:
	$(PYTHON) runtime/gvisor.py $(ARGS)

runtime-check:
	$(PYTHON) runtime/gvisor.py verify-lock
	$(PYTHON) -m unittest discover -s runtime -p '*_test.py' -v -b
	$(PYTHON) -m unittest discover -s ../dev/tools -p 'push_images_test.py' -v -b

controller-build:
	$(MAKE) -C .. build-controller

router-build:
	$(MAKE) -C .. build-sandbox-router

controller-image:
	docker build -t $(CONTROLLER_IMAGE) -f ../Dockerfile ..

router-image:
	docker build -t $(ROUTER_IMAGE) -f ../sandbox-router/Dockerfile ..

images: image controller-image router-image

controller-render:
	@KUBECONFIG=/dev/null $(HELM) template agent-sandbox ../helm --namespace $(CONTROLLER_NAMESPACE) --set namespace.create=false --set namespace.name=$(CONTROLLER_NAMESPACE) --set image.tag=$(CONTROLLER_TAG) --set controller.extensions=true

smoke-images:
	cd sandbox-api && $(BUN) run dev/smoke-images.ts
