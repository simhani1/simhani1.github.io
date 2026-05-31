---
title: JFR로 Spring Boot 애플리케이션 병목 찾기
date: 2026-06-01 02:50:56 +0900
tags:
  - JDK
  - K6
  - 부하테스트
  - Spring
  - Java
---
## 개요

Spring Boot 애플리케이션에서 성능 이슈가 발생하여 병목 구간을 찾아야 할 때가 있다. 그러나 디버깅만으로는 어느 지점에서 시간이 오래 걸리는지 판단하기 어렵다. 이러한 병목을 찾을 때 도움되는 도구를 새롭게 알게 되어 정리한다.

JFR(Java Flight Recorder)은 JDK에 포함된 프로파일링 도구다. CPU 사용량, 메서드 실행 시간, 스레드 덤프, GC 등 수많은 정보를 수집할 수 있다.

수집된 JFR 파일은 JMC(Java Mission Control)을 사용해 시각화할 수 있다. 어떤 메서드가 호출되었는지, 스레드가 얼마나 점유되었는지, 메서드 실행 시간 등 다양한 정보를 볼 수 있고 병목을 추적할 수 있다.

## 실험 환경

- Java21
- Spring Boot 3.x
- Gradle
- k6
- JFR
- JMC(Java Mission Control)

이러한 환경에서 2개의 예제 API를 만들었다.

```java
@RestController  
@RequestMapping("/heavy")  
public class HeavyController {  
  
    private static final Pattern PATTERN = Pattern.compile(".*[0-9].*");  
    private static final String INPUT = "test-user-12345";  
  
    @GetMapping("/bad")  
    public boolean analyzeBad() {  
        boolean match = false;  
        for (int i = 0; i < 1000; i++) {  
            match = INPUT.matches(".*[0-9].*");  
        }  
        return match;  
    }  
  
    @GetMapping("/good")  
    public boolean analyzeGood() {  
        boolean match = false;  
        for (int i = 0; i < 1000; i++) {  
            match = PATTERN.matcher(INPUT).matches();  
        }  
        return match;  
    }  
}
```

두 API에 대해 JFR을 켜고 K6 부하테스트를 진행하여 병목 구간을 찾을 것이다. 

우선 JFR을 실행하려면 아래와 같이 명령어를 입력한다. 6분동안 `recording-bad.jfr`파일에 상태를 저장하도록 설정하는 것이다. 

> Spring 실행 명령어

```
  JAVA_TOOL_OPTIONS="-XX:StartFlightRecording=duration=6m,filename=recording-bad.jfr,settings=profile" \
  ./gradlew bootRun
```

이후 K6 부하 테스트를 실행한다.

> 부하 스크립트

```js
import http from 'k6/http';  
  
export let options = {  
    vus: 50,  
    duration: '6m',  
};  
  
export default function () {  
    http.get('http://localhost:8080/heavy/good');  
    // http.get('http://localhost:8080/heavy/bad'); URL만 변경하여 두 API를 테스트
};
```

> K6 실행

```
k6 run k6/script-heavy-bad.js   
```

## 실행 결과 분석

> bad 결과

![](/assets/images/Pasted%20image%2020260601032341.png)

![](/assets/images/Pasted%20image%2020260601040620.png)

> good 결과

![](/assets/images/Pasted%20image%2020260601033220.png)

![](/assets/images/Pasted%20image%2020260601040646.png)

이렇게 테스트를 수행하고 생성된 JFR 파일을 JMC에서 열면 다양한 정보를 볼 수 있고 특히 호출된 메서드를 모두 추적할 수 있다. 위에서 아래 방향으로 메서드가 실행되는 것이다.

두 JFR을 비교했을 때 차이점은 bad 엔드포인트에서는 Pattern 클래스의 메서드를 많이 호출하는 것이다. bad 엔드포인트 코드를 뜯어보면 API가 호출될 때마다 `Pattern.compile()` 메서드를 호출하고 있어 매번 새로운 Pattern 객체를 생성하는 것을 알 수 있다.

```java
public final class String {

	public boolean matches(String regex) {  
	    return Pattern.matches(regex, this);  
	}
}

public final class Pattern {

	public static boolean matches(String regex, CharSequence input) { 
	    Pattern p = Pattern.compile(regex);  
	    Matcher m = p.matcher(input);  
	    return m.matches();  
	}
	
	public static Pattern compile(String regex) {  
	    return new Pattern(regex, 0);  // 객체를 매번 생성
	}	
}
```

이처럼 왼쪽과 오른쪽의 힙 메모리 사용량에서도 차이를 볼 수 있다.

![](/assets/images/Pasted%20image%2020260601040109.png)

이처럼 분석 결과를 바탕으로 코드의 예상 문제 지점을 발견하고 개선할 수 있다. 실제 위 분석표를 GPT에게 분석을 요청했을 때 받은 응답은 다음과 같다.

> JMC의 Flame Graph를 확인한 결과, 요청은 `HeavyController.analyzeData()`까지 정상적으로 진입했지만, 실제 실행 시간의 상당 부분은 `String.matches()` 이후의 정규식 처리 과정에서 사용되고 있었다. 특히 `Pattern.compile()`, `Pattern.expr()`, `Pattern.sequence()` 등의 메서드가 넓게 나타난 것으로 보아, 문자열 매칭 과정에서 정규식 패턴을 반복적으로 컴파일하는 비용이 누적된 것으로 판단할 수 있다.

## 정리

이처럼 JFR은 Spring Boot 애플리케이션에서 특정 요청이나 메서드의 병목 구간을 찾을 때 유용한 프로파일링 도구다. 단순 디버깅이나 로그만으로는 어느 지점에서 시간이 오래 걸리는지 판단하기 어렵지만, JFR을 사용하면 실제 실행 중 수집된 데이터를 바탕으로 병목 후보를 좁혀갈 수 있다. 또한 메서드 실행 흐름뿐만 아니라 CPU 사용량, 스레드 상태, GC, 메모리 할당, I/O 이벤트 등 다양한 JVM 내부 정보를 함께 제공한다.

하지만 MSA 환경처럼 하나의 요청이 여러 서비스를 거쳐 처리되는 구조에서는 JFR만으로 전체 요청 흐름을 추적하기 어렵다. 반면 로컬 환경이나 단일 Spring Boot 애플리케이션에서 특정 코드의 병목을 확인하는 용도로는 JFR과 JMC가 좋은 선택지가 될 것이다.

운영 환경에서 지속적인 프로파일링이 필요하다면 Amazon CodeGuru Profiler를 고려할 수 있다. 별도 명령어 없이도 애플리케이션이 실행되는 동안 데이터를 추적해주고 시각화도 동일하게 해준다.

## 레퍼런스

- [JFR](https://docs.redhat.com/ko/documentation/red_hat_jboss_enterprise_application_platform/8.0/html/performance_tuning_for_red_hat_jboss_enterprise_application_platform/assembly-java-flight-recorder_performance-tuning-guide)
- [JMC 사용법](https://javakr.medium.com/java-mission-control-%EC%82%AC%EC%9A%A9%EB%B2%95-45da89c6dc89)
- [AWS CodeGuru](https://docs.aws.amazon.com/whitepapers/latest/introduction-devops-aws/amazon-codeguru.html)