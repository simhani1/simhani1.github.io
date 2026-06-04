---
title: "@TransactionalEventListener(AFTER_COMMIT)에서 DB 업데이트가 반영되지 않는다"
date: 2026-06-04 01:41:07 +0900
excerpt: "AFTER_COMMIT 리스너는 DB 커밋이 끝난 뒤 실행돼 엔티티 변경이 반영되지 않는다. REQUIRES_NEW로 새 트랜잭션을 열어 해결한 과정을 정리했다."
tags:
  - Spring
  - 트랜잭션
  - DB
---
## 문제 상황

프로젝트를 리팩토링하면서 메시지 큐를 도입하여 이벤트 기반 아키텍처를 도입하던 중 이상한 문제 상황을 발견했다. 상황을 이해하기 위해 예시 코드를 가져왔다.

> OrderService

```kotlin
@Service  
class OrderService(  
    private val orderRepository: OrderRepository,  
    private val eventPublisher: ApplicationEventPublisher,  
) {  
    private val log = LoggerFactory.getLogger(javaClass)  
  
    @Transactional  
    fun createOrder(productName: String, quantity: Int): Order {    
        val order = orderRepository.save(Order(productName = productName, quantity = quantity))  
  
        eventPublisher.publishEvent(  
            OrderCreatedEvent(  
                orderId = order.id!!,  
                productName = order.productName,  
                quantity = order.quantity,  
            )  
        )
        return order  
    }  
}
```

> OutboxEventListener

```kotlin
@Component  
class OutboxEventListener(  
    private val outboxMessageRepository: OutboxMessageRepository,  
    private val messagePublisher: MessagePublisher,  
    private val objectMapper: ObjectMapper,  
) {  
    private val log = LoggerFactory.getLogger(javaClass)  
  
    @TransactionalEventListener(phase = TransactionPhase.BEFORE_COMMIT)  
    fun recordOutboxOnBeforeCommit(event: OrderCreatedEvent) {    
        val payload = objectMapper.writeValueAsString(event)  
        val saved = outboxMessageRepository.save(  
            OutboxMessage(  
                aggregateType = "Order",  
                aggregateId = event.orderId.toString(),  
                eventType = "OrderCreated",  
                payload = payload,  
            )  
        )  
    }  
  
    @Transactional
    @TransactionalEventListener(phase = TransactionPhase.AFTER_COMMIT)  
    fun publishOutboxOnAfterCommit(event: OrderCreatedEvent) {  
      
        val notification = "[알림] 주문 #${event.orderId} 생성 - ${event.productName} x ${event.quantity}"  
        messagePublisher.publish(topic = "OrderCreated", payload = notification)  
  
        val outbox = outboxMessageRepository.findByAggregateTypeAndAggregateIdAndStatus(  
            aggregateType = "Order",  
            aggregateId = event.orderId.toString(),  
            status = OutboxStatus.PENDING,  
        ) ?: run {  
            log.warn("[Outbox][AFTER_COMMIT] PENDING 아웃박스 메시지 없음 orderId={}", event.orderId)  
            return  
        }  
        // 아웃박스 메지시를 PUBLISHED로 변경
        outbox.markPublished()
    }  
}
```

흐름을 정리하면 다음과 같다.

1. 고객으로부터 주문 요청을 받는다.
2. `OrderService`는 주문을 저장하기 전, 아웃박스 테이블에 메시지를 함께 기록하는 `TransactionPhase.BEFORE_COMMIT` 이벤트를 트리거한다.
3. 주문 정보와 아웃박스 메시지가 원자적으로 커밋되어 DB에 저장된다.
4. 트랜잭션이 커밋된 직후, `TransactionPhase.AFTER_COMMIT` 이벤트를 트리거한다.
5. 주문 완료 알림을 전송하기 위해 메시지 큐로 실제 메시지를 발행하고 아웃박스 메시지 상태를 `PUBLISHED`로 변경한다.

이러한 흐름에서 이상한 버그를 발견했다. 실제 메시지 큐로 이벤트를 발행한 직후, 아웃박스 메시지 상태가 여전히 `PENDING`으로 유지된다.

## 로그와 DB 상태 관찰

웹 페이지로 API를 호출하고 실제 결과를 볼 수 있도록 페이지를 제작하고 테스트를 진행했다.(기존 코드에 로그를 심었음)

```
[Controller] POST /orders/reset - DB 초기화 요청
[Controller] DB 초기화 완료 orders=1 outbox=1
[Controller] POST /orders 요청 수신 productName=Pixel 9 quantity=1
[Service] 주문 생성 트랜잭션 시작 productName=Pixel 9 quantity=1
[Service] 주문 엔티티 저장 완료 orderId=9
[Service] OrderCreatedEvent 발행 (Spring ApplicationEvent) orderId=9
[Service] 주문 생성 트랜잭션 메서드 종료 (커밋 직전)
[Outbox][BEFORE_COMMIT] 이벤트 수신 orderId=9
[Outbox][BEFORE_COMMIT] 아웃박스 메시지 PENDING 저장 완료 outboxId=9 (비즈니스 트랜잭션에 합류)
[Outbox][AFTER_COMMIT] 이벤트 수신 orderId=9 productName=Pixel 9 quantity=1
[MQ] 메시지 발행 시작 topic=OrderCreated payload=[알림] 주문 #9 생성 - Pixel 9 x 1
[MQ] 메시지 발행 완료 topic=OrderCreated
[Outbox][AFTER_COMMIT] 알림 메시지 발행 완료 orderId=9
[Outbox][AFTER_COMMIT] 엔티티 상태 변경 완료 outboxId=9 status=PUBLISHED publishedAt=2026-06-04T21:26:35.633448
[Controller] 응답 반환 orderId=9
```

로그 상으로는 문제가 없어보인다. 그럼 실제 DB 상태는 어떻게 저장되어 있을까?

![](/assets/images/스크린샷%202026-06-04%20오후%209.26.48.png)

여전히 `PENDING` 상태로 남아있다. 이상하다. 분명 로그 상으로는 PUBLISHED로 조회되지만 실제 DB에는 PENDING으로 남아있어 상태값이 불일치한다.
아웃박스 테이블을 둔 것도 발행에 실패한 메시지를 재처리하려는 목적으로 둔 것이고, 별도 스케줄러를 등록해 PENDING 상태로 남아있는 아웃박스 레코드를 메시지 큐로 발행하는 로직을 구현한 상태였다. 그렇다면 사용자 입장에서는 이상한 경험을 하게된다.

1. 물건 구매 후 정상적으로 푸시 알림을 받음
2. 서버에서는 알림을 전송하지 못했다고 판단(PENDING 상태이므로)
3. 푸시 알림을 전송
4. 사용자는 동일한 푸시 알림을 두 번 받음

## 들어가기 앞서 @Transactional 어노테이션의 동작 방식을 살펴보자

원인을 찾기 위해 우선 스프링 트랜잭션의 동작 방식을 살펴보자. @Transactional 어노테이션이 붙은 메서드가 호출되는 순간, `TransactionInterceptor`가 가로채고 실제 트랜잭션이 동작하게 된다.

```java
public class TransactionInterceptor extends TransactionAspectSupport implements MethodInterceptor, Serializable {  

    @Override  
    @Nullable   
    public Object invoke(MethodInvocation invocation) throws Throwable {  
       // Work out the target class: may be {@code null}.  
       // The TransactionAttributeSource should be passed the target class
       // as well as the method, which may be from an interface.       
       Class<?> targetClass = (invocation.getThis() != null ? AopUtils.getTargetClass(invocation.getThis()) : null);  
  
       // Adapt to TransactionAspectSupport's invokeWithinTransaction...  
       return invokeWithinTransaction(invocation.getMethod(), targetClass, new CoroutinesInvocationCallback() {  
          @Override  
          @Nullable          public Object proceedWithInvocation() throws Throwable {  
             return invocation.proceed();  
          }  
          @Override  
          public Object getTarget() {  
             return invocation.getThis();  
          }  
          @Override  
          public Object[] getArguments() {  
             return invocation.getArguments();  
          }  
       });  
    }
}
```

`TransactionAspectSupport`의 invokeWithinTransaction 메서드 내부를 보면 실제 트랜잭션을 열고 예외가 발생하면 롤백, 그렇지 않으면 커밋하는 로직이 구현되어 있다.

```java
// 트랜잭션 시작 또는 기존 트랜잭션 참여
TransactionInfo txInfo = createTransactionIfNecessary(ptm, txAttr, joinpointIdentification);

Object retVal;
try {
    // 실제 @Transactional 대상 메서드 실행
    retVal = invocation.proceedWithInvocation();
}
catch (Throwable ex) {
    // 예외 발생 시 rollback 또는 commit 판단
    completeTransactionAfterThrowing(txInfo, ex);
    throw ex;
}
finally {
    // ThreadLocal 에 저장된 TransactionInfo 정리
    // 여기서 DB commit/rollback 하는 것은 아님
    cleanupTransactionInfo(txInfo);
}

// 정상 종료 시 commit
commitTransactionAfterReturning(txInfo);

return retVal;
```

`commitTransactionAfterReturning(txInfo)`에서 실제 커밋을 호출한다.

```java
protected void commitTransactionAfterReturning(@Nullable TransactionInfo txInfo) {  
    if (txInfo != null && txInfo.getTransactionStatus() != null) {  
       if (logger.isTraceEnabled()) {  
          logger.trace("Completing transaction for [" + txInfo.getJoinpointIdentification() + "]");  
       }  
       txInfo.getTransactionManager().commit(txInfo.getTransactionStatus());  
    }  
}
```

이제 AbstractPlatformTransactionManager의 commit 메서드 내부를 볼 것이다. 

```java
@Override  
public final void commit(TransactionStatus status) throws TransactionException {  
    if (status.isCompleted()) {  
       throw new IllegalTransactionStateException(  
             "Transaction is already completed - do not call commit or rollback more than once per transaction");  
    }  
  
    DefaultTransactionStatus defStatus = (DefaultTransactionStatus) status;  
    if (defStatus.isLocalRollbackOnly()) {  
       if (defStatus.isDebug()) {  
          logger.debug("Transactional code has requested rollback");  
       }  
       processRollback(defStatus, false);  
       return;  
    }  
  
    if (!shouldCommitOnGlobalRollbackOnly() && defStatus.isGlobalRollbackOnly()) {  
       if (defStatus.isDebug()) {  
          logger.debug("Global transaction is marked as rollback-only but transactional code requested commit");  
       }  
       processRollback(defStatus, true);  
       return;  
    }  
  
	// 실제 커밋 프로세스 시작
    processCommit(defStatus);  
}

private void processCommit(DefaultTransactionStatus status) throws TransactionException {
    try {
        boolean beforeCompletionInvoked = false;

        try {
            boolean unexpectedRollback = false;
            prepareForCommit(status);

            // BEFORE_COMMIT 이벤트 트리거: 아직 DB 커밋 전
            triggerBeforeCommit(status);

            // BEFORE_COMPLETION 콜백 트리거: DB 커밋 직전
            triggerBeforeCompletion(status);
            beforeCompletionInvoked = true;

            if (status.hasSavepoint()) {
                if (status.isDebug()) {
                    logger.debug("Releasing transaction savepoint");
                }
                unexpectedRollback = status.isGlobalRollbackOnly();

                // Savepoint 해제: 물리 DB 커밋은 아님
                status.releaseHeldSavepoint();
            }
            else if (status.isNewTransaction()) {
                if (status.isDebug()) {
                    logger.debug("Initiating transaction commit");
                }
                unexpectedRollback = status.isGlobalRollbackOnly();

                // 실제 DB 트랜잭션 커밋 수행
                doCommit(status);
            }
            else if (isFailEarlyOnGlobalRollbackOnly()) {
                unexpectedRollback = status.isGlobalRollbackOnly();
            }

            if (unexpectedRollback) {
                throw new UnexpectedRollbackException(
                        "Transaction silently rolled back because it has been marked as rollback-only");
            }
        }
        catch (UnexpectedRollbackException ex) {
            // 롤백 완료 후 AFTER_COMPLETION 콜백 트리거
            triggerAfterCompletion(status, TransactionSynchronization.STATUS_ROLLED_BACK);
            throw ex;
        }
        catch (TransactionException ex) {
            if (isRollbackOnCommitFailure()) {
                // 커밋 실패 시 롤백 처리
                doRollbackOnCommitException(status, ex);
            }
            else {
                // 커밋 결과 불명 상태로 AFTER_COMPLETION 콜백 트리거
                triggerAfterCompletion(status, TransactionSynchronization.STATUS_UNKNOWN);
            }
            throw ex;
        }
        catch (RuntimeException | Error ex) {
            if (!beforeCompletionInvoked) {
                // 예외 발생 시 BEFORE_COMPLETION 미실행 상태면 먼저 호출
                triggerBeforeCompletion(status);
            }

            // 커밋 전 예외 발생으로 롤백 처리
            doRollbackOnCommitException(status, ex);
            throw ex;
        }

        try {
            // AFTER_COMMIT 이벤트 트리거: DB 커밋 완료 후, Spring cleanup 전
            triggerAfterCommit(status);
        }
        finally {
            // AFTER_COMPLETION 콜백 트리거: 커밋 성공/실패와 관계없이 완료 통지
            triggerAfterCompletion(status, TransactionSynchronization.STATUS_COMMITTED);
        }

    }
    finally {
        // Spring 트랜잭션 정리: EntityManager unbind/close, 동기화 자원 정리
        cleanupAfterCompletion(status);
    }
}

private void triggerAfterCommit(DefaultTransactionStatus status) {  
    if (status.isNewSynchronization()) {  
       TransactionSynchronizationUtils.triggerAfterCommit();  
    }  
}

private void cleanupAfterCompletion(DefaultTransactionStatus status) {  
    status.setCompleted();  
    if (status.isNewSynchronization()) {  
       // 모든 트랜잭션 자원을 초기화
       TransactionSynchronizationManager.clear();  
    }  
    if (status.isNewTransaction()) {  
       doCleanupAfterCompletion(status.getTransaction());  
    }  
    if (status.getSuspendedResources() != null) {  
       if (status.isDebug()) {  
          logger.debug("Resuming suspended transaction after completion of inner transaction");  
       }  
       Object transaction = (status.hasTransaction() ? status.getTransaction() : null);  
       resume(transaction, (SuspendedResourcesHolder) status.getSuspendedResources());  
    }  
}
```

정리하면 Spring의 commit 흐름은 다음과 같다.

1. @Transactional 메서드 정상 종료
2. TransactionInterceptor가 commitTransactionAfterReturning() 호출
3. AbstractPlatformTransactionManager.processCommit() 진입
4. triggerBeforeCommit()
5. doCommit()
6. triggerAfterCommit()
7. triggerAfterCompletion()
8. cleanupAfterCompletion()

다시 돌아가 내가 겪은 문제 상황의 원인이 무엇인지 살펴보자.

## 문제 원인은 무엇인가

현재 프로젝트에서는 Spring Data JPA를 사용하고 있었다. JPA는 트랜잭션 매니저로 JpaTransactionManager를 사용한다. JpaTransactionManager의 doCommit 메서드를 보면 `tx.commit()`을 호출한다. 이 시점에 실제 데이터베이스 레벨의 트랜잭션이 커밋된다.

```java
@Override  
protected void doCommit(DefaultTransactionStatus status) {  
    JpaTransactionObject txObject = (JpaTransactionObject) status.getTransaction();  
    if (status.isDebug()) {  
       logger.debug("Committing JPA transaction on EntityManager [" +  
             txObject.getEntityManagerHolder().getEntityManager() + "]");  
    }  
    try {  
       EntityTransaction tx = txObject.getEntityManagerHolder().getEntityManager().getTransaction();  
       tx.commit();  
    }  
    catch (RollbackException ex) {  
       if (ex.getCause() instanceof RuntimeException runtimeException) {  
          DataAccessException dae = getJpaDialect().translateExceptionIfPossible(runtimeException);  
          if (dae != null) {  
             throw dae;  
          }  
       }  
       throw new TransactionSystemException("Could not commit JPA transaction", ex);  
    }  
    catch (RuntimeException ex) {  
       // Assumably failed to flush changes to database.  
       throw DataAccessUtils.translateIfNecessary(ex, getJpaDialect());  
    }  
}

public interface EntityTransaction {    
     /**  
      * Commit the current resource transaction, writing any      * unflushed changes to the database.    
	  * @throws IllegalStateException if <code>isActive()</code> is false  
      * @throws RollbackException if the commit fails  
      */    
      public void commit();
}
```

이제 아웃박스 메시지 상태가 업데이트 되지 않았던 이유를 알 수 있다.

```java
doCommit(status); // 실제 DB commit

try {
    triggerAfterCommit(status); // commit 성공 후 콜백
}
finally {
    triggerAfterCompletion(status, STATUS_COMMITTED); // 최종 완료 콜백
}

cleanupAfterCompletion(status); // Spring 리소스 정리
```

@TransactionalEventListener(phase = TransactionPhase.AFTER_COMMIT) 어노테이션을 붙인 메서드는 데이터베이스 레벨의 트랜잭션은 커밋된 이후 호출된다. 그래서 엔티티의 상태 변경이 데이터베이스로 반영되지 못했다. 그러나 이 시점에 스프링 트랜잭션 컨텍스트는 정리되지 않았다(cleanupAfterCompletion 메서드에 의해 정리됨). 따라서 엔티티를 조회할 때 영속성 컨텍스트의 1차 캐시에 저장된 인스턴스를 조회하지만 이 사실을 알아채기 어렵다. 이후 인스턴스의 상태 변경은 가능하지만 실제 데이터베이스로 반영되지는 않는 것이다.

실제 로그를 출력해보면 @TransactionalEventListener(phase = TransactionPhase.AFTER_COMMIT) 메서드가 호출된 시점의 엔티티가 1차 캐시에서 조회된다. `System.identityHashCode(event)`를 사용해 JVM이 객체에 부여한 고유값을 출력하면 아웃박스 엔티티의 주소값은 동일하다. 그래서 일반적인 디버깅으로는 정상적으로 동작하는 것처럼 보여서 원인을 찾기 어려웠다.

```
...
[Outbox][BEFORE_COMMIT] 이벤트 수신 orderId=11
[Outbox][BEFORE_COMMIT] 아웃박스 메시지 PENDING 저장 완료 outboxId=11 identityHashCode=1128134749 (비즈니스 트랜잭션에 합류)
[Outbox][AFTER_COMMIT] 이벤트 수신 orderId=11 productName=Pixel 9 quantity=1
[MQ] 메시지 발행 시작 topic=OrderCreated payload=[알림] 주문 #11 생성 - Pixel 9 x 1
[MQ] 메시지 발행 완료 topic=OrderCreated
[Outbox][AFTER_COMMIT] 알림 메시지 발행 완료 orderId=11
[Outbox][AFTER_COMMIT] PENDING 아웃박스 조회 outboxId=11 identityHashCode=1128134749
...
```

## 해결 방법

이를 해결하기 위해서는 AFTER_COMMIT 메서드가 실행될 때 새로운 트랜잭션을 생성하도록 하면 된다. 새로운 트랜잭션을 생성하기 때문에 엔티티의 변경사항이 데이터베이스에도 반영될 수 있게 된다.

```kotlin
@Component  
class OutboxEventListener(  
    private val outboxMessageRepository: OutboxMessageRepository,  
    private val messagePublisher: MessagePublisher,  
    private val objectMapper: ObjectMapper,  
) {  
    private val log = LoggerFactory.getLogger(javaClass)  

    @Transactional(propagation = Propagation.REQUIRES_NEW)  
    @TransactionalEventListener(phase = TransactionPhase.AFTER_COMMIT)  
    fun publishOutboxOnAfterCommit(event: OrderCreatedEvent) {  
        val notification = "[알림] 주문 #${event.orderId} 생성 - ${event.productName} x ${event.quantity}"  
        messagePublisher.publish(topic = "OrderCreated", payload = notification)  
  
        val outbox = outboxMessageRepository.findByAggregateTypeAndAggregateIdAndStatus(  
            aggregateType = "Order",  
            aggregateId = event.orderId.toString(),  
            status = OutboxStatus.PENDING,  
        ) ?: run {  
            log.warn("[Outbox][AFTER_COMMIT] PENDING 아웃박스 메시지 없음 orderId={}", event.orderId)  
            return  
        }  
        outbox.markPublished()   
    }  
}
```

이후 실행 결과를 보면 정상적으로 동작하는 것을 확인할 수 있다.

![](/assets/images/Pasted%20image%2020260605031138.png)

또한 로그에서도 엔티티의 주소값이 다르게 출력되는 것을 볼 수 있다.

```
[Outbox][BEFORE_COMMIT] 이벤트 수신 orderId=13
[Outbox][BEFORE_COMMIT] 아웃박스 메시지 PENDING 저장 완료 outboxId=13 identityHashCode=2112913566 (비즈니스 트랜잭션에 합류)
[Outbox][AFTER_COMMIT] 이벤트 수신 orderId=13 productName=Pixel 9 quantity=1
[MQ] 메시지 발행 시작 topic=OrderCreated payload=[알림] 주문 #13 생성 - Pixel 9 x 1
[MQ] 메시지 발행 완료 topic=OrderCreated
[Outbox][AFTER_COMMIT] 알림 메시지 발행 완료 orderId=13
[Outbox][AFTER_COMMIT] PENDING 아웃박스 조회 outboxId=13 identityHashCode=1362780127
```

## 정리

`AFTER_COMMIT` 리스너는 `AbstractPlatformTransactionManager.processCommit()` 내부에서 `doCommit()` 이후, `cleanupAfterCompletion()` 이전에 실행된다.

```text
doCommit()
  → 실제 DB 트랜잭션 commit

triggerAfterCommit()
  → @TransactionalEventListener(AFTER_COMMIT) 실행

triggerAfterCompletion()

cleanupAfterCompletion()
  → EntityManager unbind/close
  → TransactionSynchronizationManager 정리
```

즉 DB 트랜잭션은 이미 끝났기 때문에 엔티티 변경을 DB에 반영할 수 없다. 하지만 스프링의 트랜잭션 컨텍스트와 `EntityManager` 관련 자원은 아직 정리되기 전이므로, Repository 조회나 엔티티 객체 수정이 가능한 것처럼 보일 수 있다.

그래서 다음과 같은 상황이 발생한다.

```text
AFTER_COMMIT 리스너 실행
→ 메시지 발행 성공
→ Outbox 엔티티 조회
→ outbox.published() 호출
→ 인스턴스 상태 변경
→ 하지만 dirty checking으로 UPDATE 쿼리는 호출되지 않음
→ DB에는 PENDING 상태가 그대로 남음
```

이 문제를 해결하기 위해 처음에는 `AFTER_COMMIT` 이후 실행되는 발행 메서드에 `REQUIRES_NEW`를 적용하여 새로운 트랜잭션을 생성하도록 했다.

```kotlin
@Transactional(propagation = Propagation.REQUIRES_NEW)
@TransactionalEventListener(phase = TransactionPhase.AFTER_COMMIT)  
fun publishOutboxOnAfterCommit(event: OrderCreatedEvent) {
    ...
}
```

`REQUIRES_NEW`를 사용하면 기존 트랜잭션 동기화 컨텍스트와 분리된 새로운 트랜잭션을 시작할 수 있다. 따라서 DB 커밋 이후 cleanup 이전에 남아 있는 기존 트랜잭션 컨텍스트와 별개로 새로운 트랜잭션 안에서 Outbox 상태를 안전하게 변경할 수 있다.

## 참고사항

이 문제를 해결하면서 새롭게 알게 된 사실이 있다. **Spring Boot 3.2.x** 부터는 `@TransactionalEventListener` 메서드에 `@Transactional`을 같이 붙이는 경우, `REQUIRES_NEW`일 때만 허용하도록 수정되었다. 내 프로젝트의 버전은 낮았기 때문에 이러한 이슈를 발견할 수 있었지만 최신 버전의 프로젝트에서는 처음부터 실행되지 않는다. 아래처럼 에러가 발생하며 애플리케이션 실행 자체가 안된다.

```
org.springframework.beans.factory.BeanInitializationException: Failed to process @EventListener annotation on bean with name 'outboxEventListener': @TransactionalEventListener method must not be annotated with @Transactional unless when declared as REQUIRES_NEW or NOT_SUPPORTED: public void com.example.demo.outbox.OutboxEventListener.publishOutboxOnAfterCommit(com.example.demo.event.OrderCreatedEvent)
	at org.springframework.context.event.EventListenerMethodProcessor.afterSingletonsInstantiated(EventListenerMethodProcessor.java:145) ~[spring-context-7.0.7.jar:7.0.7]
	at org.springframework.beans.factory.support.DefaultListableBeanFactory.preInstantiateSingletons(DefaultListableBeanFactory.java:1147) ~[spring-beans-7.0.7.jar:7.0.7]
	at org.springframework.context.support.AbstractApplicationContext.finishBeanFactoryInitialization(AbstractApplicationContext.java:994) ~[spring-context-7.0.7.jar:7.0.7]
	at org.springframework.context.support.AbstractApplicationContext.refresh(AbstractApplicationContext.java:621) ~[spring-context-7.0.7.jar:7.0.7]
	at org.springframework.boot.web.server.servlet.context.ServletWebServerApplicationContext.refresh(ServletWebServerApplicationContext.java:143) ~[spring-boot-web-server-4.0.6.jar:4.0.6]
	at org.springframework.boot.SpringApplication.refresh(SpringApplication.java:756) ~[spring-boot-4.0.6.jar:4.0.6]
	at org.springframework.boot.SpringApplication.refreshContext(SpringApplication.java:445) ~[spring-boot-4.0.6.jar:4.0.6]
	at org.springframework.boot.SpringApplication.run(SpringApplication.java:321) ~[spring-boot-4.0.6.jar:4.0.6]
	at org.springframework.boot.SpringApplication.run(SpringApplication.java:1365) ~[spring-boot-4.0.6.jar:4.0.6]
	at org.springframework.boot.SpringApplication.run(SpringApplication.java:1354) ~[spring-boot-4.0.6.jar:4.0.6]
	at com.example.demo.DemoApplicationKt.main(DemoApplication.kt:13) ~[main/:na]
Caused by: java.lang.IllegalStateException: @TransactionalEventListener method must not be annotated with @Transactional unless when declared as REQUIRES_NEW or NOT_SUPPORTED: public void com.example.demo.outbox.OutboxEventListener.publishOutboxOnAfterCommit(com.example.demo.event.OrderCreatedEvent)
	at org.springframework.transaction.annotation.RestrictedTransactionalEventListenerFactory.createApplicationListener(RestrictedTransactionalEventListenerFactory.java:52) ~[spring-tx-7.0.7.jar:7.0.7]
	at org.springframework.context.event.EventListenerMethodProcessor.processBean(EventListenerMethodProcessor.java:187) ~[spring-context-7.0.7.jar:7.0.7]
	at org.springframework.context.event.EventListenerMethodProcessor.afterSingletonsInstantiated(EventListenerMethodProcessor.java:141) ~[spring-context-7.0.7.jar:7.0.7]
	... 10 common frames omitted
```

## 레퍼런스

- [@TransactionalEventListener(AFTER_COMMIT)에서 업데이트가 반영되지 않는 문제 해결](https://curiousjinan.tistory.com/entry/fixing-spring-transactionaleventlistener-after-commit-update-issue)
- [Enforce REQUIRES_NEW for correct transaction configuration on transactional event listeners](https://github.com/spring-projects/spring-framework/issues/31414)